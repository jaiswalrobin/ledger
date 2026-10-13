import { COVERAGE_LABEL, deriveCoverage, describeActivity, maskEmail, type Coverage, type SyncState } from "../domain/coverage.ts";
import type { ApplicationEventKind, Outcome, Stage } from "../domain/types.ts";
import type { ExtractedFields, SignalKind } from "../ingestion/source.ts";
import type { Db } from "./db.ts";
import type { ReviewReason } from "./pipeline.ts";
import { iso } from "./store.ts";

export interface AttemptView {
  id: string;
  applicantEmailMasked: string;
  stage: Stage;
  outcome: Outcome;
  submittedAt: string | null;
  lastActivityAt: string | null;
  conflicts: string[];
  coverage: Coverage;
  coverageLabel: string;
  activity: string;
}

export interface OpeningView {
  id: string;
  company: string;
  title: string;
  location: string | null;
  canonicalUrl: string | null;
  attempts: AttemptView[];
  latestActivityAt: string | null;
}

interface AttemptRow {
  id: string; job_opening_id: string; applicant_email_snapshot: string | null; stage: Stage; outcome: Outcome;
  submitted_at: unknown; last_activity_at: unknown; projection_conflicts: string[];
}

async function attemptViews(db: Db, userId: string, rows: AttemptRow[], now: Date): Promise<Map<string, AttemptView[]>> {
  const facts = await db.query<{ attempt_id: string; sync_state: SyncState; backfill_complete: boolean }>(
    `SELECT DISTINCT e.attempt_id, m.sync_state, m.backfill_complete
       FROM application_events e
       JOIN event_evidence ev ON ev.event_id = e.id AND ev.user_id = e.user_id
       JOIN source_artifacts a ON a.id = ev.artifact_id AND a.user_id = ev.user_id AND a.source_kind = 'GMAIL'
       JOIN connected_mailboxes m ON m.id = a.mailbox_id AND m.user_id = a.user_id
      WHERE e.user_id = $1 AND e.review_state = 'ACCEPTED'`, [userId]);
  const byAttempt = new Map<string, { syncState: SyncState; backfillComplete: boolean }[]>();
  for (const f of facts.rows) {
    const list = byAttempt.get(f.attempt_id) ?? [];
    list.push({ syncState: f.sync_state, backfillComplete: f.backfill_complete });
    byAttempt.set(f.attempt_id, list);
  }
  const out = new Map<string, AttemptView[]>();
  for (const r of rows) {
    const coverage = deriveCoverage(byAttempt.get(r.id) ?? []);
    const lastActivityAt = r.last_activity_at ? iso(r.last_activity_at) : null;
    const view: AttemptView = {
      id: r.id, applicantEmailMasked: maskEmail(r.applicant_email_snapshot), stage: r.stage, outcome: r.outcome,
      submittedAt: r.submitted_at ? iso(r.submitted_at) : null, lastActivityAt, conflicts: r.projection_conflicts,
      coverage, coverageLabel: COVERAGE_LABEL[coverage], activity: describeActivity(lastActivityAt, now, coverage),
    };
    const list = out.get(r.job_opening_id) ?? [];
    list.push(view);
    out.set(r.job_opening_id, list);
  }
  return out;
}

const ATTEMPT_COLUMNS = "id, job_opening_id, applicant_email_snapshot, stage, outcome, submitted_at, last_activity_at, projection_conflicts";

export async function listOpenings(db: Db, userId: string, now = new Date()): Promise<OpeningView[]> {
  const openings = await db.query<{ id: string; company: string; title: string; location: string | null; canonical_url: string | null }>(
    `SELECT o.id, c.canonical_name AS company, o.title, o.location, o.canonical_url
       FROM job_openings o JOIN companies c ON c.id = o.company_id AND c.user_id = o.user_id WHERE o.user_id = $1`, [userId]);
  const attempts = await db.query<AttemptRow>(`SELECT ${ATTEMPT_COLUMNS} FROM application_attempts WHERE user_id = $1 ORDER BY created_at, id`, [userId]);
  const views = await attemptViews(db, userId, attempts.rows, now);
  const list: OpeningView[] = openings.rows.map(o => {
    const mine = views.get(o.id) ?? [];
    const latest = mine.map(a => a.lastActivityAt).filter((v): v is string => !!v).sort().at(-1) ?? null;
    return { id: o.id, company: o.company, title: o.title, location: o.location, canonicalUrl: o.canonical_url, attempts: mine, latestActivityAt: latest };
  });
  return list.sort((a, b) => (b.latestActivityAt ?? "").localeCompare(a.latestActivityAt ?? "") || a.company.localeCompare(b.company));
}

export interface EvidenceView {
  sourceKind: "GMAIL" | "FORWARDED_EML" | "MANUAL";
  subject: string | null;
  originalMessageAt: string | null;
  mailboxAddress: string | null;
  providerMessageId: string | null;
}

export interface EventView {
  id: string;
  kind: ApplicationEventKind;
  occurredAt: string;
  reviewState: "PROPOSED" | "ACCEPTED" | "REJECTED" | "SUPERSEDED";
  origin: "AUTO" | "MANUAL";
  evidence: EvidenceView[];
}

export interface OpeningDetail extends Omit<OpeningView, "attempts"> {
  attempts: (AttemptView & { events: EventView[] })[];
}

export async function getOpening(db: Db, userId: string, openingId: string, now = new Date()): Promise<OpeningDetail | null> {
  const opening = await db.query<{ id: string; company: string; title: string; location: string | null; canonical_url: string | null }>(
    `SELECT o.id, c.canonical_name AS company, o.title, o.location, o.canonical_url
       FROM job_openings o JOIN companies c ON c.id = o.company_id AND c.user_id = o.user_id
      WHERE o.user_id = $1 AND o.id = $2`, [userId, openingId]);
  const o = opening.rows[0];
  if (!o) return null;
  const attempts = await db.query<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM application_attempts WHERE user_id = $1 AND job_opening_id = $2 ORDER BY created_at, id`, [userId, openingId]);
  const views = (await attemptViews(db, userId, attempts.rows, now)).get(openingId) ?? [];
  const ids = attempts.rows.map(a => a.id);

  const events = await db.query<{ id: string; attempt_id: string; event_kind: ApplicationEventKind; occurred_at: unknown; review_state: EventView["reviewState"]; origin: "AUTO" | "MANUAL" }>(
    `SELECT id, attempt_id, event_kind, occurred_at, review_state, origin FROM application_events
      WHERE user_id = $1 AND attempt_id = ANY($2::uuid[]) ORDER BY occurred_at, id`, [userId, ids]);
  const evidence = await db.query<{ event_id: string; source_kind: EvidenceView["sourceKind"]; subject_redacted: string | null; original_message_at: unknown; provider_message_id: string | null; address: string | null }>(
    `SELECT ev.event_id, a.source_kind, a.subject_redacted, a.original_message_at, a.provider_message_id, m.address
       FROM event_evidence ev
       JOIN source_artifacts a ON a.id = ev.artifact_id AND a.user_id = ev.user_id
       LEFT JOIN connected_mailboxes m ON m.id = a.mailbox_id AND m.user_id = a.user_id
      WHERE ev.user_id = $1 AND ev.event_id = ANY($2::uuid[]) ORDER BY a.source_observed_at`, [userId, events.rows.map(e => e.id)]);
  const evidenceByEvent = new Map<string, EvidenceView[]>();
  for (const e of evidence.rows) {
    const list = evidenceByEvent.get(e.event_id) ?? [];
    list.push({
      sourceKind: e.source_kind, subject: e.subject_redacted, originalMessageAt: e.original_message_at ? iso(e.original_message_at) : null,
      mailboxAddress: e.address, providerMessageId: e.provider_message_id,
    });
    evidenceByEvent.set(e.event_id, list);
  }
  const eventViews = new Map<string, EventView[]>();
  for (const e of events.rows) {
    const list = eventViews.get(e.attempt_id) ?? [];
    list.push({ id: e.id, kind: e.event_kind, occurredAt: iso(e.occurred_at), reviewState: e.review_state, origin: e.origin, evidence: evidenceByEvent.get(e.id) ?? [] });
    eventViews.set(e.attempt_id, list);
  }
  const withEvents = views.map(v => ({ ...v, events: eventViews.get(v.id) ?? [] }));
  const latest = views.map(a => a.lastActivityAt).filter((v): v is string => !!v).sort().at(-1) ?? null;
  return { id: o.id, company: o.company, title: o.title, location: o.location, canonicalUrl: o.canonical_url, attempts: withEvents, latestActivityAt: latest };
}

export interface ReviewCandidate {
  attemptId: string;
  applicantEmailMasked: string;
  openingTitle: string;
  company: string;
}

export interface ReviewView {
  id: string;
  reason: ReviewReason;
  kind: SignalKind | null;
  fields: ExtractedFields;
  subject: string | null;
  sourceKind: "GMAIL" | "FORWARDED_EML";
  originalMessageAt: string | null;
  createdAt: string;
  candidates: ReviewCandidate[];
  candidateOpenings: { openingId: string; title: string; company: string }[];
}

export async function listReviews(db: Db, userId: string): Promise<ReviewView[]> {
  const { rows } = await db.query<{
    id: string; reason_code: ReviewReason; created_at: unknown; candidate_attempt_ids: string[]; candidate_opening_ids: string[];
    event_kind: SignalKind | null; fields: ExtractedFields; subject_redacted: string | null; source_kind: "GMAIL" | "FORWARDED_EML"; original_message_at: unknown;
  }>(
    `SELECT r.id, r.reason_code, r.created_at, r.candidate_attempt_ids, r.candidate_opening_ids, s.event_kind, s.fields,
            a.subject_redacted, a.source_kind, a.original_message_at
       FROM review_items r
       JOIN extracted_signals s ON s.id = r.signal_id AND s.user_id = r.user_id
       JOIN source_artifacts a ON a.id = r.source_artifact_id AND a.user_id = r.user_id
      WHERE r.user_id = $1 AND r.state = 'OPEN' ORDER BY r.created_at DESC, r.id`, [userId]);
  const attemptIds = [...new Set(rows.flatMap(r => r.candidate_attempt_ids))];
  const openingIds = [...new Set(rows.flatMap(r => r.candidate_opening_ids))];
  const attemptInfo = new Map<string, ReviewCandidate>();
  if (attemptIds.length) {
    const a = await db.query<{ id: string; applicant_email_snapshot: string | null; title: string; company: string }>(
      `SELECT at.id, at.applicant_email_snapshot, o.title, c.canonical_name AS company
         FROM application_attempts at
         JOIN job_openings o ON o.id = at.job_opening_id AND o.user_id = at.user_id
         JOIN companies c ON c.id = o.company_id AND c.user_id = o.user_id
        WHERE at.user_id = $1 AND at.id = ANY($2::uuid[])`, [userId, attemptIds]);
    for (const r of a.rows) attemptInfo.set(r.id, { attemptId: r.id, applicantEmailMasked: maskEmail(r.applicant_email_snapshot), openingTitle: r.title, company: r.company });
  }
  const openingInfo = new Map<string, { openingId: string; title: string; company: string }>();
  if (openingIds.length) {
    const o = await db.query<{ id: string; title: string; company: string }>(
      `SELECT o.id, o.title, c.canonical_name AS company FROM job_openings o JOIN companies c ON c.id = o.company_id AND c.user_id = o.user_id
        WHERE o.user_id = $1 AND o.id = ANY($2::uuid[])`, [userId, openingIds]);
    for (const r of o.rows) openingInfo.set(r.id, { openingId: r.id, title: r.title, company: r.company });
  }
  return rows.map(r => ({
    id: r.id, reason: r.reason_code, kind: r.event_kind, fields: r.fields, subject: r.subject_redacted, sourceKind: r.source_kind,
    originalMessageAt: r.original_message_at ? iso(r.original_message_at) : null, createdAt: iso(r.created_at),
    candidates: r.candidate_attempt_ids.flatMap(id => attemptInfo.get(id) ?? []),
    candidateOpenings: r.candidate_opening_ids.flatMap(id => openingInfo.get(id) ?? []),
  }));
}

export async function countOpenReviews(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>("SELECT count(*) AS n FROM review_items WHERE user_id = $1 AND state = 'OPEN'", [userId]);
  return Number(rows[0]!.n);
}

export interface RunView {
  kind: string; state: string; startedAt: string; finishedAt: string | null; discovered: number; headersInspected: number;
  bodiesFetched: number; skippedSensitive: number; skippedOther: number; signalsApplied: number; reviewsCreated: number;
  tasksFailed: number; safeErrorCode: string | null;
}

export interface MailboxView {
  id: string;
  address: string;
  syncState: SyncState;
  backfillComplete: boolean;
  backfillStart: string | null;
  backfillEnd: string | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
  pendingTasks: number;
  lastRun: RunView | null;
}

export async function listMailboxes(db: Db, userId: string): Promise<MailboxView[]> {
  const { rows } = await db.query<{
    id: string; address: string; sync_state: SyncState; backfill_complete: boolean; backfill_start: unknown; backfill_end: unknown;
    last_success_at: unknown; last_attempt_at: unknown; last_error_code: string | null;
  }>(
    `SELECT id, address, sync_state, backfill_complete, backfill_start, backfill_end, last_success_at, last_attempt_at, last_error_code
       FROM connected_mailboxes WHERE user_id = $1 ORDER BY created_at, id`, [userId]);
  const result: MailboxView[] = [];
  for (const m of rows) {
    const run = await db.query<{
      kind: string; state: string; started_at: unknown; finished_at: unknown; discovered_count: number; headers_inspected: number; bodies_fetched: number;
      skipped_sensitive: number; skipped_other: number; signals_applied: number; reviews_created: number; tasks_failed: number; safe_error_code: string | null;
    }>("SELECT * FROM sync_runs WHERE mailbox_id = $1 ORDER BY started_at DESC, id LIMIT 1", [m.id]);
    const pending = await db.query<{ n: string }>("SELECT count(*) AS n FROM processing_tasks WHERE mailbox_id = $1 AND state = 'PENDING'", [m.id]);
    const r = run.rows[0];
    result.push({
      id: m.id, address: m.address, syncState: m.sync_state, backfillComplete: m.backfill_complete,
      backfillStart: m.backfill_start ? iso(m.backfill_start) : null, backfillEnd: m.backfill_end ? iso(m.backfill_end) : null,
      lastSuccessAt: m.last_success_at ? iso(m.last_success_at) : null, lastAttemptAt: m.last_attempt_at ? iso(m.last_attempt_at) : null,
      lastErrorCode: m.last_error_code, pendingTasks: Number(pending.rows[0]!.n),
      lastRun: r ? {
        kind: r.kind, state: r.state, startedAt: iso(r.started_at), finishedAt: r.finished_at ? iso(r.finished_at) : null,
        discovered: r.discovered_count, headersInspected: r.headers_inspected, bodiesFetched: r.bodies_fetched, skippedSensitive: r.skipped_sensitive,
        skippedOther: r.skipped_other, signalsApplied: r.signals_applied, reviewsCreated: r.reviews_created, tasksFailed: r.tasks_failed, safeErrorCode: r.safe_error_code,
      } : null,
    });
  }
  return result;
}
