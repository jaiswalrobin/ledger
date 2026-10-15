import {
  COVERAGE_LABEL,
  deriveCoverage,
  describeActivity,
  maskEmail,
  type Coverage,
  type SyncState,
} from "../domain/coverage.ts";
import type { ApplicationEventKind, Outcome, Stage } from "../domain/types.ts";
import { isRecruitingSenderDomain } from "../ingestion/ats.ts";
import type { ExtractedFields, SignalKind } from "../ingestion/source.ts";
import type { Db } from "./db.ts";
import type { ReviewReason } from "./pipeline.ts";
import {
  interviewRounds,
  type Round,
  type RoundKind,
} from "../domain/rounds.ts";
import { iso, CALENDAR_REVISION_ORDER, stepEventsByAttempt } from "./store.ts";

export interface AttemptView {
  id: string;
  applicantEmailMasked: string;
  stage: Stage;
  outcome: Outcome;
  submittedAt: string | null;
  lastActivityAt: string | null;
  nextInterviewAt: string | null;
  /** The latest assessment or interview round, for "Interview · Round 2". */
  round: { number: number; kind: RoundKind } | null;
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
  id: string;
  job_opening_id: string;
  applicant_email_snapshot: string | null;
  stage: Stage;
  outcome: Outcome;
  submitted_at: unknown;
  last_activity_at: unknown;
  projection_conflicts: string[];
}

async function attemptViews(
  db: Db,
  userId: string,
  rows: AttemptRow[],
  now: Date,
): Promise<Map<string, AttemptView[]>> {
  if (!rows.length) return new Map();
  const attemptIds = rows.map((r) => r.id);
  const facts = await db.query<{
    attempt_id: string;
    sync_state: SyncState;
    backfill_complete: boolean;
    last_success_at: unknown;
    unsettled: boolean;
  }>(
    `SELECT DISTINCT e.attempt_id, m.sync_state, m.backfill_complete,m.last_success_at,
      EXISTS(SELECT 1 FROM processing_tasks t WHERE t.mailbox_id=m.id AND t.state IN ('PENDING','FAILED')) AS unsettled
       FROM application_events e
       JOIN event_evidence ev ON ev.event_id = e.id AND ev.user_id = e.user_id
       JOIN source_artifacts a ON a.id = ev.artifact_id AND a.user_id = ev.user_id AND a.source_kind = 'GMAIL'
       JOIN connected_mailboxes m ON m.id = a.mailbox_id AND m.user_id = a.user_id
      WHERE e.user_id = $1 AND e.attempt_id=ANY($2::uuid[]) AND e.review_state = 'ACCEPTED'`,
    [userId, attemptIds],
  );
  // Select each calendar's latest accepted revision before considering its time. Filtering
  // future times first would incorrectly revive an older invitation after a reschedule.
  const schedules = await db.query<{
    attempt_id: string;
    scheduled_for: unknown;
  }>(
    `SELECT attempt_id,min(scheduled_for) AS scheduled_for FROM (
       SELECT DISTINCT ON (attempt_id,calendar_uid_key) attempt_id,scheduled_for
       FROM application_events WHERE user_id=$1 AND attempt_id=ANY($2::uuid[])
         AND review_state='ACCEPTED' AND calendar_uid_key IS NOT NULL
       ORDER BY attempt_id,calendar_uid_key,${CALENDAR_REVISION_ORDER}
     ) current_calendar WHERE scheduled_for >= $3 GROUP BY attempt_id`,
    [userId, attemptIds, now.toISOString()],
  );
  const upcoming = new Map(
    schedules.rows.map((r) => [r.attempt_id, iso(r.scheduled_for)]),
  );
  const steps = await stepEventsByAttempt(db, userId, attemptIds);
  const byAttempt = new Map<
    string,
    { syncState: SyncState; backfillComplete: boolean }[]
  >();
  for (const f of facts.rows) {
    const list = byAttempt.get(f.attempt_id) ?? [];
    const stale =
      !f.last_success_at ||
      now.getTime() - Date.parse(iso(f.last_success_at)) > 45 * 60000;
    list.push({
      syncState:
        f.sync_state === "HEALTHY" && (stale || f.unsettled)
          ? "DEGRADED"
          : f.sync_state,
      backfillComplete: f.backfill_complete,
    });
    byAttempt.set(f.attempt_id, list);
  }
  const out = new Map<string, AttemptView[]>();
  for (const r of rows) {
    const coverage = deriveCoverage(byAttempt.get(r.id) ?? []);
    const lastActivityAt = r.last_activity_at ? iso(r.last_activity_at) : null;
    const view: AttemptView = {
      id: r.id,
      applicantEmailMasked: maskEmail(r.applicant_email_snapshot),
      stage: r.stage,
      outcome: r.outcome,
      submittedAt: r.submitted_at ? iso(r.submitted_at) : null,
      lastActivityAt,
      round: latestRound(steps.get(r.id) ?? []),
      nextInterviewAt:
        r.outcome === "PENDING" ? (upcoming.get(r.id) ?? null) : null,
      conflicts: r.projection_conflicts,
      coverage,
      coverageLabel: COVERAGE_LABEL[coverage],
      activity: describeActivity(lastActivityAt, now, coverage),
    };
    const list = out.get(r.job_opening_id) ?? [];
    list.push(view);
    out.set(r.job_opening_id, list);
  }
  return out;
}

const ATTEMPT_COLUMNS =
  "id, job_opening_id, applicant_email_snapshot, stage, outcome, submitted_at, last_activity_at, projection_conflicts";

export async function listOpenings(
  db: Db,
  userId: string,
  now = new Date(),
): Promise<OpeningView[]> {
  const openings = await db.query<{
    id: string;
    company: string;
    title: string;
    location: string | null;
    canonical_url: string | null;
  }>(
    `SELECT o.id, c.canonical_name AS company, o.title, o.location, o.canonical_url
       FROM job_openings o JOIN companies c ON c.id = o.company_id AND c.user_id = o.user_id WHERE o.user_id = $1`,
    [userId],
  );
  const attempts = await db.query<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM application_attempts WHERE user_id = $1 ORDER BY submitted_at NULLS LAST,created_at,id`,
    [userId],
  );
  const views = await attemptViews(db, userId, attempts.rows, now);
  const list: OpeningView[] = openings.rows.map((o) => {
    const mine = views.get(o.id) ?? [];
    const latest =
      mine
        .map((a) => a.lastActivityAt)
        .filter((v): v is string => !!v)
        .sort()
        .at(-1) ?? null;
    return {
      id: o.id,
      company: o.company,
      title: o.title,
      location: o.location,
      canonicalUrl: o.canonical_url,
      attempts: mine,
      latestActivityAt: latest,
    };
  });
  return list.sort(
    (a, b) =>
      (b.latestActivityAt ?? "").localeCompare(a.latestActivityAt ?? "") ||
      a.company.localeCompare(b.company),
  );
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
  /** The assessment or interview round this event belongs to. */
  round: number | null;
  /** Marked as starting a new round, by its email's wording or by the owner. */
  startsRound: boolean;
  kind: ApplicationEventKind;
  occurredAt: string;
  reviewState: "PROPOSED" | "ACCEPTED" | "REJECTED" | "SUPERSEDED";
  origin: "AUTO" | "MANUAL";
  evidence: EvidenceView[];
  scheduledFor: string | null;
  calendarRevision: number | null;
  currentSchedule: boolean;
}

export interface RoundView {
  number: number;
  kind: RoundKind;
  startedAt: string;
  /** The latest time of the round's calendar invitation, if one was received. */
  meetingAt: string | null;
  reschedules: number;
  scheduled: boolean;
  /** An earlier round never reached Ledger; numbering starts at 2. */
  followsUnseenRound: boolean;
  /** Emails supporting the round's events. */
  emails: number;
}

export interface OpeningDetail extends Omit<OpeningView, "attempts"> {
  attempts: (AttemptView & {
    rounds: RoundView[];
    events: EventView[];
    submissionDateCorrections: {
      previousAt: string | null;
      correctedAt: string;
      createdAt: string;
    }[];
  })[];
}

export async function getOpening(
  db: Db,
  userId: string,
  openingId: string,
  now = new Date(),
): Promise<OpeningDetail | null> {
  const opening = await db.query<{
    id: string;
    company: string;
    title: string;
    location: string | null;
    canonical_url: string | null;
  }>(
    `SELECT o.id, c.canonical_name AS company, o.title, o.location, o.canonical_url
       FROM job_openings o JOIN companies c ON c.id = o.company_id AND c.user_id = o.user_id
      WHERE o.user_id = $1 AND o.id = $2`,
    [userId, openingId],
  );
  const o = opening.rows[0];
  if (!o) return null;
  const attempts = await db.query<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM application_attempts WHERE user_id = $1 AND job_opening_id = $2 ORDER BY submitted_at NULLS LAST,created_at,id`,
    [userId, openingId],
  );
  const views =
    (await attemptViews(db, userId, attempts.rows, now)).get(openingId) ?? [];
  const ids = attempts.rows.map((a) => a.id);

  const events = await db.query<{
    id: string;
    attempt_id: string;
    event_kind: ApplicationEventKind;
    occurred_at: unknown;
    review_state: EventView["reviewState"];
    origin: "AUTO" | "MANUAL";
    calendar_uid_key: string | null;
    calendar_sequence: number | null;
    scheduled_for: unknown;
    current_schedule: boolean;
    starts_round: boolean;
  }>(
    `SELECT id, attempt_id, event_kind, occurred_at, review_state, origin,calendar_uid_key,calendar_sequence,scheduled_for,starts_round,
       calendar_uid_key IS NOT NULL AND review_state='ACCEPTED' AND id=first_value(id) OVER (
         PARTITION BY attempt_id,calendar_uid_key ORDER BY CASE WHEN review_state='ACCEPTED' THEN 0 ELSE 1 END,${CALENDAR_REVISION_ORDER}
       ) AS current_schedule FROM application_events
      WHERE user_id = $1 AND attempt_id = ANY($2::uuid[]) ORDER BY occurred_at, id`,
    [userId, ids],
  );
  const evidence = await db.query<{
    event_id: string;
    source_kind: EvidenceView["sourceKind"];
    subject_redacted: string | null;
    original_message_at: unknown;
    provider_message_id: string | null;
    address: string | null;
  }>(
    `SELECT ev.event_id, a.source_kind, a.subject_redacted, a.original_message_at, a.provider_message_id, m.address
       FROM event_evidence ev
       JOIN source_artifacts a ON a.id = ev.artifact_id AND a.user_id = ev.user_id
       LEFT JOIN connected_mailboxes m ON m.id = a.mailbox_id AND m.user_id = a.user_id
      WHERE ev.user_id = $1 AND ev.event_id = ANY($2::uuid[]) ORDER BY a.source_observed_at`,
    [userId, events.rows.map((e) => e.id)],
  );
  const evidenceByEvent = new Map<string, EvidenceView[]>();
  for (const e of evidence.rows) {
    const list = evidenceByEvent.get(e.event_id) ?? [];
    list.push({
      sourceKind: e.source_kind,
      subject: e.subject_redacted,
      originalMessageAt: e.original_message_at
        ? iso(e.original_message_at)
        : null,
      mailboxAddress: e.address,
      providerMessageId: e.provider_message_id,
    });
    evidenceByEvent.set(e.event_id, list);
  }
  const steps = await stepEventsByAttempt(db, userId, ids);
  const roundsByAttempt = new Map<string, Round[]>(
    ids.map((id) => [id, interviewRounds(steps.get(id) ?? [])]),
  );
  const roundOfEvent = new Map<string, number>();
  for (const rounds of roundsByAttempt.values())
    for (const round of rounds)
      for (const id of round.eventIds) roundOfEvent.set(id, round.number);
  const eventViews = new Map<string, EventView[]>();
  for (const e of events.rows) {
    const list = eventViews.get(e.attempt_id) ?? [];
    list.push({
      id: e.id,
      round: roundOfEvent.get(e.id) ?? null,
      startsRound: e.starts_round,
      kind: e.event_kind,
      occurredAt: iso(e.occurred_at),
      reviewState: e.review_state,
      origin: e.origin,
      evidence: evidenceByEvent.get(e.id) ?? [],
      scheduledFor: e.scheduled_for ? iso(e.scheduled_for) : null,
      calendarRevision:
        e.calendar_sequence === null ? null : Number(e.calendar_sequence),
      currentSchedule: e.current_schedule,
    });
    eventViews.set(e.attempt_id, list);
  }
  const corrections = await db.query<{
    attempt_id: string;
    previous_submitted_at: unknown;
    corrected_submitted_at: unknown;
    created_at: unknown;
  }>(
    "SELECT attempt_id,previous_submitted_at,corrected_submitted_at,created_at FROM submission_date_corrections WHERE user_id=$1 AND attempt_id=ANY($2::uuid[]) ORDER BY created_at,id",
    [userId, ids],
  );
  const withEvents = views.map((v) => ({
    ...v,
    rounds: (roundsByAttempt.get(v.id) ?? []).map((round): RoundView => ({
      number: round.number,
      kind: round.kind,
      startedAt: round.startedAt,
      meetingAt: round.meeting?.scheduledFor ?? null,
      reschedules: round.reschedules,
      scheduled: round.scheduled,
      followsUnseenRound: round.followsUnseenRound,
      emails: round.eventIds.reduce(
        (sum, id) => sum + (evidenceByEvent.get(id)?.length ?? 0),
        0,
      ),
    })),
    events: eventViews.get(v.id) ?? [],
    submissionDateCorrections: corrections.rows
      .filter((c) => c.attempt_id === v.id)
      .map((c) => ({
        previousAt: c.previous_submitted_at
          ? iso(c.previous_submitted_at)
          : null,
        correctedAt: iso(c.corrected_submitted_at),
        createdAt: iso(c.created_at),
      })),
  }));
  const latest =
    views
      .map((a) => a.lastActivityAt)
      .filter((v): v is string => !!v)
      .sort()
      .at(-1) ?? null;
  return {
    id: o.id,
    company: o.company,
    title: o.title,
    location: o.location,
    canonicalUrl: o.canonical_url,
    attempts: withEvents,
    latestActivityAt: latest,
  };
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
  mailboxAddress: string | null;
  providerMessageId: string | null;
  /**
   * The sender's domain when it belongs to one employer, for grouping emails about one job.
   * Null for shared hiring platforms (greenhouse.io, ashbyhq.com), which every employer uses.
   */
  employerDomain: string | null;
}

export async function listReviews(
  db: Db,
  userId: string,
): Promise<ReviewView[]> {
  const { rows } = await db.query<{
    id: string;
    reason_code: ReviewReason;
    created_at: unknown;
    candidate_attempt_ids: string[];
    candidate_opening_ids: string[];
    event_kind: SignalKind | null;
    fields: ExtractedFields;
    subject_redacted: string | null;
    source_kind: "GMAIL" | "FORWARDED_EML";
    original_message_at: unknown;
    mailbox_address: string | null;
    provider_message_id: string | null;
    sender_domain: string | null;
  }>(
    `SELECT r.id, r.reason_code, r.created_at, r.candidate_attempt_ids, r.candidate_opening_ids, s.event_kind, s.fields,
            a.subject_redacted, a.source_kind, a.original_message_at,m.address AS mailbox_address,a.provider_message_id,
            a.sender_domain
       FROM review_items r
       JOIN extracted_signals s ON s.id = r.signal_id AND s.user_id = r.user_id
       JOIN source_artifacts a ON a.id = r.source_artifact_id AND a.user_id = r.user_id
       LEFT JOIN connected_mailboxes m ON m.id=a.mailbox_id AND m.user_id=a.user_id
      WHERE r.user_id = $1 AND r.state = 'OPEN' ORDER BY r.created_at DESC, r.id`,
    [userId],
  );
  const attemptIds = [...new Set(rows.flatMap((r) => r.candidate_attempt_ids))];
  const openingIds = [...new Set(rows.flatMap((r) => r.candidate_opening_ids))];
  const attemptInfo = new Map<string, ReviewCandidate>();
  if (attemptIds.length) {
    const a = await db.query<{
      id: string;
      applicant_email_snapshot: string | null;
      title: string;
      company: string;
    }>(
      `SELECT at.id, at.applicant_email_snapshot, o.title, c.canonical_name AS company
         FROM application_attempts at
         JOIN job_openings o ON o.id = at.job_opening_id AND o.user_id = at.user_id
         JOIN companies c ON c.id = o.company_id AND c.user_id = o.user_id
        WHERE at.user_id = $1 AND at.id = ANY($2::uuid[])`,
      [userId, attemptIds],
    );
    for (const r of a.rows)
      attemptInfo.set(r.id, {
        attemptId: r.id,
        applicantEmailMasked: maskEmail(r.applicant_email_snapshot),
        openingTitle: r.title,
        company: r.company,
      });
  }
  const openingInfo = new Map<
    string,
    { openingId: string; title: string; company: string }
  >();
  if (openingIds.length) {
    const o = await db.query<{ id: string; title: string; company: string }>(
      `SELECT o.id, o.title, c.canonical_name AS company FROM job_openings o JOIN companies c ON c.id = o.company_id AND c.user_id = o.user_id
        WHERE o.user_id = $1 AND o.id = ANY($2::uuid[])`,
      [userId, openingIds],
    );
    for (const r of o.rows)
      openingInfo.set(r.id, {
        openingId: r.id,
        title: r.title,
        company: r.company,
      });
  }
  return rows.map((r) => ({
    id: r.id,
    reason: r.reason_code,
    kind: r.event_kind,
    fields: r.fields,
    subject: r.subject_redacted,
    sourceKind: r.source_kind,
    originalMessageAt: r.original_message_at
      ? iso(r.original_message_at)
      : null,
    createdAt: iso(r.created_at),
    candidates: r.candidate_attempt_ids.flatMap(
      (id) => attemptInfo.get(id) ?? [],
    ),
    candidateOpenings: r.candidate_opening_ids.flatMap(
      (id) => openingInfo.get(id) ?? [],
    ),
    mailboxAddress: r.mailbox_address,
    providerMessageId: r.provider_message_id,
    employerDomain:
      r.sender_domain && !isRecruitingSenderDomain(r.sender_domain)
        ? r.sender_domain
        : null,
  }));
}

export async function countOpenReviews(
  db: Db,
  userId: string,
): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM review_items WHERE user_id = $1 AND state = 'OPEN'",
    [userId],
  );
  return Number(rows[0]!.n);
}

export interface RunView {
  kind: string;
  state: string;
  startedAt: string;
  finishedAt: string | null;
  discovered: number;
  headersInspected: number;
  bodiesFetched: number;
  skippedSensitive: number;
  skippedOther: number;
  signalsApplied: number;
  reviewsCreated: number;
  tasksFailed: number;
  safeErrorCode: string | null;
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
  failedTasks: number;
  lastRun: RunView | null;
  recheckInProgress: boolean;
  processingSummary: {
    processed: number;
    skippedSensitive: number;
    unrecognized: number;
    skippedOther: number;
    quarantined: number;
    partiallyProcessed: number;
  };
  excludedMessages: {
    messageId: string;
    reason: "PRIVACY_CHECK" | "NO_EVENT" | "PARSE_LIMIT" | "UNCERTAIN_HEADERS";
    originalMessageAt: string | null;
  }[];
}

export async function listMailboxes(
  db: Db,
  userId: string,
): Promise<MailboxView[]> {
  const { rows } = await db.query<{
    id: string;
    address: string;
    sync_state: SyncState;
    backfill_complete: boolean;
    backfill_start: unknown;
    backfill_end: unknown;
    last_success_at: unknown;
    last_attempt_at: unknown;
    last_error_code: string | null;
    recheck_id: string | null;
  }>(
    `SELECT id, address, sync_state, backfill_complete, backfill_start, backfill_end, last_success_at, last_attempt_at, last_error_code, recheck_id
       FROM connected_mailboxes WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  );
  if (!rows.length) return [];
  const mailboxIds = rows.map((m) => m.id);
  // Batch every read across the owner's mailboxes: the query count does not grow per account.
  const run = await db.query<{
    mailbox_id: string;
    kind: string;
    state: string;
    started_at: unknown;
    finished_at: unknown;
    discovered_count: number;
    headers_inspected: number;
    bodies_fetched: number;
    skipped_sensitive: number;
    skipped_other: number;
    signals_applied: number;
    reviews_created: number;
    tasks_failed: number;
    safe_error_code: string | null;
  }>(
    "SELECT DISTINCT ON (mailbox_id) * FROM sync_runs WHERE mailbox_id = ANY($1::uuid[]) ORDER BY mailbox_id, started_at DESC, id",
    [mailboxIds],
  );
  const tasks = await db.query<{
    mailbox_id: string;
    pending: string;
    failed: string;
  }>(
    `SELECT mailbox_id, count(*) FILTER (WHERE state='PENDING') AS pending,
         count(*) FILTER (WHERE state='FAILED' AND outcome<>'DISCONNECTED') AS failed
       FROM processing_tasks WHERE mailbox_id=ANY($1::uuid[]) AND user_id=$2 GROUP BY mailbox_id`,
    [mailboxIds, userId],
  );
  const outcomes = await db.query<{
    mailbox_id: string;
    category: string;
    n: string;
  }>(
    `SELECT t.mailbox_id, CASE
         WHEN t.outcome='PROCESSED' THEN 'processed'
         WHEN t.outcome='PROCESSED_PARTIAL' THEN 'partiallyProcessed'
         WHEN t.outcome='SKIPPED_SENSITIVE' OR a.body_access_decision='SKIPPED_SENSITIVE' THEN 'skippedSensitive'
         WHEN t.outcome='NO_SIGNAL' THEN 'unrecognized'
         WHEN left(t.outcome,12)='QUARANTINED_' THEN 'quarantined'
         ELSE 'skippedOther' END AS category, count(*) AS n
       FROM processing_tasks t LEFT JOIN source_artifacts a ON a.user_id=t.user_id AND a.mailbox_id=t.mailbox_id
         AND a.provider_message_id=t.provider_message_id AND a.source_kind='GMAIL'
       WHERE t.mailbox_id=ANY($1::uuid[]) AND t.user_id=$2 AND t.state='DONE' GROUP BY t.mailbox_id, category`,
    [mailboxIds, userId],
  );
  const excluded = await db.query<{
    mailbox_id: string;
    provider_message_id: string;
    reason: MailboxView["excludedMessages"][number]["reason"];
    original_message_at: unknown;
  }>(
    `SELECT * FROM (SELECT t.mailbox_id, t.provider_message_id, a.original_message_at,
         row_number() OVER (PARTITION BY t.mailbox_id ORDER BY t.finished_at DESC NULLS LAST, t.id) AS rank, CASE
         WHEN t.outcome='SKIPPED_SENSITIVE' OR a.body_access_decision='SKIPPED_SENSITIVE' THEN 'PRIVACY_CHECK'
         WHEN left(t.outcome,12)='QUARANTINED_' OR t.outcome='PROCESSED_PARTIAL' THEN 'PARSE_LIMIT'
         WHEN t.outcome='SKIPPED_UNCERTAIN' THEN 'UNCERTAIN_HEADERS' ELSE 'NO_EVENT' END AS reason
       FROM processing_tasks t LEFT JOIN source_artifacts a ON a.user_id=t.user_id AND a.mailbox_id=t.mailbox_id
         AND a.provider_message_id=t.provider_message_id AND a.source_kind='GMAIL'
       WHERE t.mailbox_id=ANY($1::uuid[]) AND t.user_id=$2 AND t.state='DONE'
         AND (t.outcome IN ('NO_SIGNAL','SKIPPED_SENSITIVE','SKIPPED_UNCERTAIN','PROCESSED_PARTIAL') OR left(t.outcome,12)='QUARANTINED_')
       ) ranked WHERE rank<=20 ORDER BY mailbox_id, rank`,
    [mailboxIds, userId],
  );
  const runsByMailbox = new Map(run.rows.map((r) => [r.mailbox_id, r]));
  const tasksByMailbox = new Map(tasks.rows.map((t) => [t.mailbox_id, t]));
  const summaries = new Map<string, MailboxView["processingSummary"]>();
  for (const o of outcomes.rows) {
    const summary = summaries.get(o.mailbox_id) ?? {
      processed: 0,
      skippedSensitive: 0,
      unrecognized: 0,
      skippedOther: 0,
      quarantined: 0,
      partiallyProcessed: 0,
    };
    summary[o.category as keyof typeof summary] = Number(o.n);
    summaries.set(o.mailbox_id, summary);
  }
  const exclusions = new Map<string, MailboxView["excludedMessages"]>();
  for (const e of excluded.rows) {
    const list = exclusions.get(e.mailbox_id) ?? [];
    list.push({
      messageId: e.provider_message_id,
      reason: e.reason,
      originalMessageAt: e.original_message_at
        ? iso(e.original_message_at)
        : null,
    });
    exclusions.set(e.mailbox_id, list);
  }
  const result: MailboxView[] = [];
  for (const m of rows) {
    const r = runsByMailbox.get(m.id),
      counts = tasksByMailbox.get(m.id);
    result.push({
      id: m.id,
      address: m.address,
      syncState: m.sync_state,
      backfillComplete: m.backfill_complete,
      backfillStart: m.backfill_start ? iso(m.backfill_start) : null,
      backfillEnd: m.backfill_end ? iso(m.backfill_end) : null,
      lastSuccessAt: m.last_success_at ? iso(m.last_success_at) : null,
      lastAttemptAt: m.last_attempt_at ? iso(m.last_attempt_at) : null,
      lastErrorCode: m.last_error_code,
      pendingTasks: Number(counts?.pending ?? 0),
      failedTasks: Number(counts?.failed ?? 0),
      recheckInProgress: m.recheck_id !== null,
      processingSummary: summaries.get(m.id) ?? {
        processed: 0,
        skippedSensitive: 0,
        unrecognized: 0,
        skippedOther: 0,
        quarantined: 0,
        partiallyProcessed: 0,
      },
      excludedMessages: exclusions.get(m.id) ?? [],
      lastRun: r
        ? {
            kind: r.kind,
            state: r.state,
            startedAt: iso(r.started_at),
            finishedAt: r.finished_at ? iso(r.finished_at) : null,
            discovered: r.discovered_count,
            headersInspected: r.headers_inspected,
            bodiesFetched: r.bodies_fetched,
            skippedSensitive: r.skipped_sensitive,
            skippedOther: r.skipped_other,
            signalsApplied: r.signals_applied,
            reviewsCreated: r.reviews_created,
            tasksFailed: r.tasks_failed,
            safeErrorCode: r.safe_error_code,
          }
        : null,
    });
  }
  return result;
}

function latestRound(
  events: Parameters<typeof interviewRounds>[0],
): AttemptView["round"] {
  const round = interviewRounds(events).at(-1);
  return round ? { number: round.number, kind: round.kind } : null;
}
