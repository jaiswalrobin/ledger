import { randomUUID } from "node:crypto";
import { companyKey, normalizedText } from "../domain/normalization.ts";
import { projectAttempt } from "../domain/projection.ts";
import type {
  ApplicationAttempt,
  ApplicationEvent,
  ApplicationEventKind,
  AtsKey,
  JobOpening,
  Outcome,
  Stage,
} from "../domain/types.ts";
import type { Db } from "./db.ts";
import type { CalendarFacts } from "../ingestion/source.ts";

/** Postgres returns timestamptz as Date; the domain speaks ISO strings. */
export const iso = (value: unknown): string =>
  (value instanceof Date ? value : new Date(String(value))).toISOString();

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505"
  );
}

// ---- openings & attempts ----------------------------------------------------------------

interface OpeningRow {
  id: string;
  company: string;
  title: string;
  location: string | null;
  ats_provider: string | null;
  ats_tenant: string | null;
  requisition_id: string | null;
  canonical_url: string | null;
}

export async function loadOpenings(
  db: Db,
  userId: string,
  filter?: {id?:string;title?:string;atsKey?:AtsKey|null;canonicalUrl?:string|null},
): Promise<JobOpening[]> {
  const params:unknown[]=[userId];
  const conditions:string[]=[];
  const bind=(value:unknown)=>{params.push(value);return `$${params.length}`;};
  if(filter?.id)conditions.push(`o.id=${bind(filter.id)}::uuid`);
  else if(filter?.atsKey)conditions.push(`o.ats_provider=${bind(normalizedText(filter.atsKey.provider))} AND o.ats_tenant=${bind(normalizedText(filter.atsKey.tenant))} AND o.requisition_id=${bind(filter.atsKey.requisitionId)}`);
  else if(filter?.title){
    const title=`lower(regexp_replace(btrim(o.title),'\\s+',' ','g'))=${bind(normalizedText(filter.title))}`;
    conditions.push(filter.canonicalUrl?`(${title} OR o.canonical_url=${bind(filter.canonicalUrl)})`:title);
  }
  const { rows } = await db.query<OpeningRow>(
    `SELECT o.id, c.canonical_name AS company, o.title, o.location, o.ats_provider, o.ats_tenant,
            o.requisition_id, o.canonical_url
       FROM job_openings o JOIN companies c ON c.id = o.company_id AND c.user_id = o.user_id
      WHERE o.user_id = $1${conditions.length?" AND "+conditions.join(" AND "):""}`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    company: r.company,
    title: r.title,
    location: r.location,
    canonicalUrl: r.canonical_url,
    atsKey:
      r.ats_provider && r.ats_tenant && r.requisition_id
        ? {
            provider: r.ats_provider,
            tenant: r.ats_tenant,
            requisitionId: r.requisition_id,
          }
        : null,
  }));
}

interface AttemptRow {
  id: string;
  job_opening_id: string;
  applicant_email_snapshot: string | null;
  phone_lookup_key: string | null;
  external_application_id: string | null;
  submission_evidence_ids: string[];
}

export async function loadAttempts(
  db: Db,
  userId: string,
  openingId: string,
): Promise<ApplicationAttempt[]> {
  const { rows } = await db.query<AttemptRow>(
    `SELECT id, job_opening_id, applicant_email_snapshot, phone_lookup_key, external_application_id, submission_evidence_ids
       FROM application_attempts WHERE user_id = $1 AND job_opening_id = $2 ORDER BY created_at, id`,
    [userId, openingId],
  );
  return rows.map((r) => ({
    id: r.id,
    openingId: r.job_opening_id,
    applicantEmail: r.applicant_email_snapshot,
    phoneLookupKey: r.phone_lookup_key,
    externalApplicationId: r.external_application_id,
    submissionEvidenceIds: r.submission_evidence_ids,
  }));
}

export async function findAttemptsByExternalId(
  db: Db,
  userId: string,
  externalId: string,
) {
  const { rows } = await db.query<{ id: string; job_opening_id: string }>(
    "SELECT id, job_opening_id FROM application_attempts WHERE user_id = $1 AND external_application_id = $2",
    [userId, externalId],
  );
  return rows.map((r) => ({ id: r.id, openingId: r.job_opening_id }));
}

/** Company/title (and location only when the signal has one) equality: a hint, never a stable identity. */
export function weakOpeningCandidates(
  signal: { company: string; title: string; location: string | null },
  openings: readonly JobOpening[],
): JobOpening[] {
  return openings.filter(
    (o) =>
      companyKey(o.company) === companyKey(signal.company) &&
      normalizedText(o.title) === normalizedText(signal.title) &&
      (!signal.location ||
        normalizedText(o.location ?? "") === normalizedText(signal.location)),
  );
}

export async function upsertCompany(
  db: Db,
  userId: string,
  name: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO companies (id, user_id, canonical_name, name_key) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, name_key) DO UPDATE SET canonical_name = companies.canonical_name
     RETURNING id`,
    [randomUUID(), userId, name.trim(), normalizedText(name)],
  );
  return rows[0]!.id;
}

export async function insertOpening(
  db: Db,
  userId: string,
  fields: {
    company: string;
    title: string;
    location: string | null;
    atsKey: AtsKey | null;
    canonicalUrl: string | null;
  },
): Promise<string> {
  const companyId = await upsertCompany(db, userId, fields.company);
  const id = randomUUID();
  await db.query(
    `INSERT INTO job_openings (id, user_id, company_id, title, location, ats_provider, ats_tenant, requisition_id, canonical_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      userId,
      companyId,
      fields.title.trim(),
      fields.location,
      fields.atsKey ? normalizedText(fields.atsKey.provider) : null,
      fields.atsKey ? normalizedText(fields.atsKey.tenant) : null,
      fields.atsKey ? fields.atsKey.requisitionId.trim() : null,
      fields.canonicalUrl,
    ],
  );
  return id;
}

export async function insertAttempt(
  db: Db,
  userId: string,
  openingId: string,
  fields: {
    applicantEmail: string | null;
    externalApplicationId: string | null;
    submittedAt: string | null;
    evidenceKey: string;
    submissionEvidence?: boolean;
  },
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO application_attempts (id, user_id, job_opening_id, applicant_email_snapshot, external_application_id, submitted_at, submission_evidence_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      userId,
      openingId,
      fields.applicantEmail,
      fields.externalApplicationId,
      fields.submittedAt,
      fields.submissionEvidence === false ? [] : [fields.evidenceKey],
    ],
  );
  return id;
}

export async function addSubmissionEvidence(
  db: Db,
  userId: string,
  attemptId: string,
  key: string,
): Promise<void> {
  await db.query(
    `UPDATE application_attempts SET submission_evidence_ids = array_append(submission_evidence_ids, $3)
      WHERE id = $2 AND user_id = $1 AND NOT ($3 = ANY (submission_evidence_ids))`,
    [userId, attemptId, key],
  );
}

/** Accepted confirmations fill missing submission facts, preserving earlier snapshots and dates.
 * Receipt evidence is distinct from status-update evidence on a manually created attempt. */
export async function acceptSubmissionEvidence(
  db: Db,userId: string,attemptId: string,key: string,occurredAt: string,
  fields: {applicantEmail:string|null;externalApplicationId:string|null},
): Promise<void> {
  await addSubmissionEvidence(db,userId,attemptId,key);
  await db.query(`UPDATE application_attempts SET submitted_at=coalesce(submitted_at,$3),
    applicant_email_snapshot=coalesce(applicant_email_snapshot,$4),external_application_id=coalesce(external_application_id,$5)
    WHERE user_id=$1 AND id=$2`,[userId,attemptId,occurredAt,fields.applicantEmail,fields.externalApplicationId]);
}

// ---- events & projection ----------------------------------------------------------------

export interface NewEvent {
  userId: string;
  attemptId: string;
  kind: ApplicationEventKind;
  occurredAt: string;
  sourceType: "GMAIL" | "FORWARDED_EML" | "MANUAL";
  origin: "AUTO" | "MANUAL";
  dedupeKey: string;
  correction?: { stage: Stage; outcome: Outcome };
  signalId?: string;
  calendar?: CalendarFacts;
  senderDomain?: string;
}

/** Validate automatic changes before accepting evidence, including late-arriving conflicts. */
export async function automaticEventProblem(
  db: Db,
  e: NewEvent,
): Promise<"EVENT_PRECEDES_SUBMISSION" | "CONFLICTING_EVENTS" | null> {
  const attempt = await db.query<{ submitted_at: unknown }>(
    "SELECT submitted_at FROM application_attempts WHERE id=$1 AND user_id=$2",
    [e.attemptId, e.userId],
  );
  const submitted = attempt.rows[0]?.submitted_at;
  if (submitted && Date.parse(e.occurredAt) < Date.parse(iso(submitted)))
    return "EVENT_PRECEDES_SUBMISSION";
  const rows = await db.query<EventRow>(
    `SELECT id,attempt_id,event_kind,occurred_at,observed_at,
    review_state,correction_stage,correction_outcome FROM application_events WHERE user_id=$1 AND attempt_id=$2`,
    [e.userId, e.attemptId],
  );
  const existing: ApplicationEvent[] = rows.rows.map((r) => ({
    id: r.id,
    attemptId: r.attempt_id,
    kind: r.event_kind,
    occurredAt: iso(r.occurred_at),
    observedAt: iso(r.observed_at),
    reviewState: r.review_state,
    evidenceId: null,
    ...(r.correction_stage && r.correction_outcome
      ? {
          correction: {
            stage: r.correction_stage,
            outcome: r.correction_outcome,
          },
        }
      : {}),
  }));
  const candidate: ApplicationEvent = {
    id: randomUUID(),
    attemptId: e.attemptId,
    kind: e.kind,
    occurredAt: e.occurredAt,
    observedAt: new Date().toISOString(),
    reviewState: "ACCEPTED",
    evidenceId: null,
  };
  return projectAttempt(e.attemptId, [...existing, candidate]).conflicts
    .length > projectAttempt(e.attemptId, existing).conflicts.length
    ? "CONFLICTING_EVENTS"
    : null;
}

export async function insertEvent(
  db: Db,
  e: NewEvent,
): Promise<{ id: string; created: boolean }> {
  const id = randomUUID();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO application_events (id, user_id, attempt_id, event_kind, occurred_at, review_state, source_type, origin, dedupe_key, correction_stage, correction_outcome,
      calendar_uid_key,calendar_sequence,calendar_method,calendar_status,calendar_organizer_domain,calendar_sender_domain,scheduled_for)
     VALUES ($1,$2,$3,$4,$5,'ACCEPTED',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
    [
      id,
      e.userId,
      e.attemptId,
      e.kind,
      e.occurredAt,
      e.sourceType,
      e.origin,
      e.dedupeKey,
      e.correction?.stage ?? null,
      e.correction?.outcome ?? null,
      e.calendar?.uidKey ?? null, e.calendar?.sequence ?? null, e.calendar?.method ?? null,
      e.calendar?.status ?? null, e.calendar?.organizerDomain ?? null, e.senderDomain ?? null,
      e.calendar?.scheduledFor ?? null,
    ],
  );
  if (rows.length) return { id, created: true };
  const existing = await db.query<{ id: string }>(
    "SELECT id FROM application_events WHERE user_id = $1 AND dedupe_key = $2",
    [e.userId, e.dedupeKey],
  );
  return { id: existing.rows[0]!.id, created: false };
}

export async function linkEvidence(
  db: Db,
  userId: string,
  eventId: string,
  artifactId: string,
  signalId?: string,
): Promise<void> {
  await db.query(
    `INSERT INTO event_evidence (user_id, event_id, artifact_id, evidence_kind,signal_id) VALUES ($1,$2,$3,'SOURCE_EMAIL',$4)
     ON CONFLICT DO NOTHING`,
    [userId, eventId, artifactId, signalId ?? null],
  );
}

interface EventRow {
  id: string;
  attempt_id: string;
  event_kind: ApplicationEventKind;
  occurred_at: unknown;
  observed_at: unknown;
  review_state: ApplicationEvent["reviewState"];
  correction_stage: Stage | null;
  correction_outcome: Outcome | null;
}

/** Recomputes and stores the read model from accepted events. Pure projection, transactional write. */
export async function reproject(
  db: Db,
  userId: string,
  attemptId: string,
): Promise<void> {
  const { rows } = await db.query<EventRow>(
    `SELECT id, attempt_id, event_kind, occurred_at, observed_at, review_state, correction_stage, correction_outcome
       FROM application_events WHERE user_id = $1 AND attempt_id = $2`,
    [userId, attemptId],
  );
  const events: ApplicationEvent[] = rows.map((r) => ({
    id: r.id,
    attemptId: r.attempt_id,
    kind: r.event_kind,
    occurredAt: iso(r.occurred_at),
    observedAt: iso(r.observed_at),
    reviewState: r.review_state,
    evidenceId: null,
    ...(r.correction_stage && r.correction_outcome
      ? {
          correction: {
            stage: r.correction_stage,
            outcome: r.correction_outcome,
          },
        }
      : {}),
  }));
  const p = projectAttempt(attemptId, events);
  await db.query(
    `UPDATE application_attempts SET stage = $3, outcome = $4, last_activity_at = $5, projection_conflicts = $6
      WHERE user_id = $1 AND id = $2`,
    [userId, attemptId, p.stage, p.outcome, p.lastActivityAt, [...p.conflicts]],
  );
}

/** Insert an accepted event, attach its evidence and refresh the read model. */
export async function recordEvent(
  db: Db,
  e: NewEvent,
  artifactId: string | null,
): Promise<{ id: string; created: boolean }> {
  const result = await insertEvent(db, e);
  if (artifactId) await linkEvidence(db, e.userId, result.id, artifactId, e.signalId);
  await reproject(db, e.userId, e.attemptId);
  return result;
}

// ---- calendar revisions: read accepted event facts, never arbitrary historical proposals. ----
export async function attemptsForCalendarUid(db: Db,userId: string,_excludeSignalId: string,uidKey: string): Promise<{attemptId:string;openingId:string}[]> {
  const {rows}=await db.query<{attempt_id:string;opening_id:string}>(
    `SELECT DISTINCT e.attempt_id,a.job_opening_id AS opening_id FROM application_events e
     JOIN application_attempts a ON a.id=e.attempt_id AND a.user_id=e.user_id
     WHERE e.user_id=$1 AND e.calendar_uid_key=$2 AND e.review_state='ACCEPTED'`,[userId,uidKey]);
  return rows.map(r=>({attemptId:r.attempt_id,openingId:r.opening_id}));
}
export async function latestCalendarRevision(db: Db,userId: string,_excludeSignalId: string,uidKey: string): Promise<{eventId:string;attemptId:string;calendar:CalendarFacts;senderDomain:string|null}|null> {
  const {rows}=await db.query<{id:string;attempt_id:string;calendar_uid_key:string;calendar_sequence:number;calendar_method:string;calendar_status:string;calendar_organizer_domain:string|null;calendar_sender_domain:string|null;scheduled_for:unknown}>(
    `SELECT id,attempt_id,calendar_uid_key,calendar_sequence,calendar_method,calendar_status,calendar_organizer_domain,calendar_sender_domain,scheduled_for
     FROM application_events WHERE user_id=$1 AND calendar_uid_key=$2 AND review_state='ACCEPTED'
     ORDER BY calendar_sequence DESC,occurred_at DESC,id LIMIT 1`,[userId,uidKey]);
  const r=rows[0];
  return r?{eventId:r.id,attemptId:r.attempt_id,senderDomain:r.calendar_sender_domain,calendar:{uidKey:r.calendar_uid_key,sequence:Number(r.calendar_sequence),method:r.calendar_method,status:r.calendar_status,organizerDomain:r.calendar_organizer_domain,scheduledFor:r.scheduled_for?iso(r.scheduled_for):null}}:null;
}

const CALENDAR_IDENTITY = ["uidKey", "sequence", "method", "status", "scheduledFor", "organizerDomain"] as const;

/** Two observations of one invitation revision: every safe calendar fact agrees. */
export const sameCalendarRevision = (a: CalendarFacts, b: CalendarFacts): boolean =>
  CALENDAR_IDENTITY.every((key) => a[key] === b[key]);

/** Whether one of the attempt's confirmations was received by this Gmail mailbox. */
export async function attemptConfirmedInMailbox(
  db: Db,
  userId: string,
  attemptId: string,
  mailboxId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM application_attempts t
       JOIN source_artifacts a ON a.user_id = t.user_id
        AND (a.original_key = ANY(t.submission_evidence_ids) OR a.source_fingerprint = ANY(t.submission_evidence_ids))
      WHERE t.user_id = $1 AND t.id = $2 AND a.mailbox_id = $3
      LIMIT 1`,
    [userId, attemptId, mailboxId],
  );
  return rows.length > 0;
}
