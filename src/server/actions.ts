import { randomUUID } from "node:crypto";
import type { AtsKey, Outcome, Stage } from "../domain/types.ts";
import type { ExtractedFields, SignalKind } from "../ingestion/source.ts";
import type { Db } from "./db.ts";
import { reconcileWaitingUpdates } from "./pipeline.ts";
import { usableEventDate } from "../ingestion/dates.ts";
import {
  insertAttempt,
  insertOpening,
  recordEvent,
  reproject,
  acceptSubmissionEvidence,
} from "./store.ts";

export type ActionErrorCode =
  "NOT_FOUND" | "ALREADY_RESOLVED" | "KIND_REQUIRED" | "INVALID_INPUT";

/** Safe to show to the owner: codes only, never message content. */
export class ActionError extends Error {
  readonly code: ActionErrorCode;
  constructor(code: ActionErrorCode) {
    super(code);
    this.code = code;
  }
}

const SIGNAL_KINDS: readonly SignalKind[] = [
  "CONFIRMATION_RECEIVED",
  "ASSESSMENT_INVITED",
  "INTERVIEW_INVITED",
  "INTERVIEW_SCHEDULED",
  "REJECTION_RECEIVED",
  "OFFER_RECEIVED",
];
const STAGES: readonly Stage[] = [
  "UNKNOWN",
  "APPLIED",
  "ASSESSMENT",
  "INTERVIEW",
];
const OUTCOMES: readonly Outcome[] = [
  "PENDING",
  "REJECTED",
  "OFFERED",
  "WITHDRAWN",
];
async function serializeOwner(db: Db, userId: string): Promise<void> {
  if (
    !(
      await db.query("SELECT id FROM ledger_users WHERE id=$1 FOR UPDATE", [
        userId,
      ])
    ).rows.length
  )
    throw new ActionError("NOT_FOUND");
}

/** Every mutation re-checks ownership in SQL: the user id is part of each WHERE clause. */
async function ownedAttempt(
  db: Db,
  userId: string,
  attemptId: string,
): Promise<{ openingId: string }> {
  const { rows } = await db.query<{ job_opening_id: string }>(
    "SELECT job_opening_id FROM application_attempts WHERE id = $1 AND user_id = $2",
    [attemptId, userId],
  );
  if (!rows[0]) throw new ActionError("NOT_FOUND");
  return { openingId: rows[0].job_opening_id };
}

export async function setAttemptStatus(
  db: Db,
  userId: string,
  attemptId: string,
  status: { stage: Stage; outcome: Outcome },
): Promise<void> {
  if (!STAGES.includes(status.stage) || !OUTCOMES.includes(status.outcome))
    throw new ActionError("INVALID_INPUT");
  await db.transaction(async (tx) => {
    await serializeOwner(tx, userId);
    await ownedAttempt(tx, userId, attemptId);
    await recordEvent(
      tx,
      {
        userId,
        attemptId,
        kind: "MANUAL_CORRECTION",
        occurredAt: new Date().toISOString(),
        sourceType: "MANUAL",
        origin: "MANUAL",
        dedupeKey: `manual:${randomUUID()}`,
        correction: status,
      },
      null,
    );
  });
}

/** Rejecting keeps the event and its evidence (provenance) but removes it from the projection. */
export async function setEventState(
  db: Db,
  userId: string,
  eventId: string,
  state: "ACCEPTED" | "REJECTED",
): Promise<void> {
  if (state !== "ACCEPTED" && state !== "REJECTED")
    throw new ActionError("INVALID_INPUT");
  await db.transaction(async (tx) => {
    await serializeOwner(tx, userId);
    const { rows } = await tx.query<{ attempt_id: string }>(
      "UPDATE application_events SET review_state = $3 WHERE id = $1 AND user_id = $2 RETURNING attempt_id",
      [eventId, userId, state],
    );
    if (!rows[0]) throw new ActionError("NOT_FOUND");
    await reproject(tx, userId, rows[0].attempt_id);
  });
}

interface ReviewContext {
  signalId: string;
  artifactId: string;
  sourceKind: "GMAIL" | "FORWARDED_EML";
  kind: SignalKind | null;
  fields: ExtractedFields;
  occurredAt: string | null;
  evidenceKey: string;
  senderDomain: string | null;
}

async function loadOpenReview(
  tx: Db,
  userId: string,
  reviewId: string,
): Promise<ReviewContext> {
  const { rows } = await tx.query<{
    state: string;
    signal_id: string;
    event_kind: SignalKind | null;
    fields: ExtractedFields;
    artifact_id: string;
    source_kind: "GMAIL" | "FORWARDED_EML";
    original_message_at: unknown;
    original_key: string | null;
    source_fingerprint: string;
    sender_domain: string | null;
  }>(
    `SELECT r.state, s.id AS signal_id, s.event_kind, s.fields, a.id AS artifact_id, a.source_kind, a.original_message_at,
            a.original_key, a.source_fingerprint,a.sender_domain
       FROM review_items r
       JOIN extracted_signals s ON s.id = r.signal_id AND s.user_id = r.user_id
       JOIN source_artifacts a ON a.id = r.source_artifact_id AND a.user_id = r.user_id
      WHERE r.id = $1 AND r.user_id = $2 FOR UPDATE OF r`,
    [reviewId, userId],
  );
  const row = rows[0];
  if (!row) throw new ActionError("NOT_FOUND");
  if (row.state !== "OPEN") throw new ActionError("ALREADY_RESOLVED");
  return {
    signalId: row.signal_id,
    artifactId: row.artifact_id,
    sourceKind: row.source_kind,
    kind: row.event_kind,
    fields: row.fields,
    occurredAt: row.original_message_at
      ? new Date(row.original_message_at as string | Date).toISOString()
      : null,
    evidenceKey: row.original_key ?? row.source_fingerprint,
    senderDomain: row.sender_domain,
  };
}

async function closeReview(
  tx: Db,
  userId: string,
  reviewId: string,
  ctx: ReviewContext | null,
  state: "RESOLVED" | "DISMISSED",
  resolution: string,
) {
  await tx.query(
    "UPDATE review_items SET state = $3, resolution = $4, resolved_at = now() WHERE id = $1 AND user_id = $2",
    [reviewId, userId, state, resolution],
  );
  if (ctx)
    await tx.query(
      "UPDATE extracted_signals SET processing_state = $2 WHERE id = $1",
      [ctx.signalId, state === "RESOLVED" ? "APPLIED" : "DISMISSED"],
    );
}

interface Overrides {
  kind?: SignalKind;
  /** ISO instant, only needed when the message had no usable Date. */
  occurredAt?: string;
}

function resolveKindAndTime(
  ctx: ReviewContext,
  o: Overrides,
): { kind: SignalKind; occurredAt: string } {
  const kind = o.kind ?? ctx.kind;
  if (!kind) throw new ActionError("KIND_REQUIRED");
  if (!SIGNAL_KINDS.includes(kind)) throw new ActionError("INVALID_INPUT");
  const occurredAt = o.occurredAt ?? ctx.occurredAt;
  const usable = usableEventDate(occurredAt);
  if (!usable) throw new ActionError("INVALID_INPUT");
  return { kind, occurredAt: usable };
}

/** Corrects a bad submission clock without hiding its original value or evidence. */
export async function correctSubmissionDate(
  db: Db,
  userId: string,
  attemptId: string,
  value: string,
): Promise<void> {
  const correctedAt = usableEventDate(value);
  if (!correctedAt) throw new ActionError("INVALID_INPUT");
  await db.transaction(async (tx) => {
    await serializeOwner(tx, userId);
    await ownedAttempt(tx, userId, attemptId);
    const row = (
      await tx.query<{ submitted_at: unknown }>(
        "SELECT submitted_at FROM application_attempts WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [attemptId, userId],
      )
    ).rows[0]!;
    const old = row.submitted_at
      ? new Date(row.submitted_at as Date | string).toISOString()
      : null;
    if (old === correctedAt) return;
    const events = await tx.query<{ id: string }>(
      `UPDATE application_events SET occurred_at=$4, origin='MANUAL'
       WHERE attempt_id=$1 AND user_id=$2 AND event_kind IN ('SUBMITTED','CONFIRMATION_RECEIVED')
         AND occurred_at IS NOT DISTINCT FROM $3::timestamptz RETURNING id`,
      [attemptId, userId, old, correctedAt],
    );
    await tx.query(
      "UPDATE application_attempts SET submitted_at=$3 WHERE id=$1 AND user_id=$2",
      [attemptId, userId, correctedAt],
    );
    await tx.query(
      `INSERT INTO submission_date_corrections(id,user_id,attempt_id,previous_submitted_at,corrected_submitted_at,event_ids)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        randomUUID(),
        userId,
        attemptId,
        old,
        correctedAt,
        events.rows.map((e) => e.id),
      ],
    );
    await reproject(tx, userId, attemptId);
  });
}

export async function resolveReviewAssign(
  db: Db,
  userId: string,
  reviewId: string,
  attemptId: string,
  overrides: Overrides = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    await serializeOwner(tx, userId);
    const ctx = await loadOpenReview(tx, userId, reviewId);
    const { openingId } = await ownedAttempt(tx, userId, attemptId);
    const { kind, occurredAt } = resolveKindAndTime(ctx, overrides);
    if (kind === "CONFIRMATION_RECEIVED")
      await acceptSubmissionEvidence(
        tx,
        userId,
        attemptId,
        ctx.evidenceKey,
        occurredAt,
        ctx.fields,
      );
    await recordEvent(
      tx,
      {
        userId,
        attemptId,
        kind,
        occurredAt,
        sourceType: ctx.sourceKind,
        origin: "MANUAL",
        dedupeKey: `${attemptId}:${kind}:${ctx.evidenceKey}`,
        signalId: ctx.signalId,
        ...(kind === "INTERVIEW_SCHEDULED" && ctx.fields.calendar
          ? {
              calendar: ctx.fields.calendar,
              senderDomain: ctx.senderDomain ?? "",
            }
          : {}),
      },
      ctx.artifactId,
    );
    await closeReview(tx, userId, reviewId, ctx, "RESOLVED", "ASSIGNED");
    // Any accepted email can be what waiting ones were missing: a reply's thread, or the
    // employer's domain on an application that had no evidence from it yet.
    await reconcileWaitingUpdates(tx, userId, new Date(), openingId);
  });
}

export interface CreateInput extends Overrides {
  openingId?: string;
  company?: string;
  title?: string;
  location?: string | null;
  applicantEmail?: string | null;
  externalApplicationId?: string | null;
}

/** Creates an attempt (and an opening unless one is chosen) from the signal, as the owner directs. */
export async function resolveReviewCreate(
  db: Db,
  userId: string,
  reviewId: string,
  input: CreateInput,
): Promise<{ attemptId: string; openingId: string }> {
  return db.transaction(async (tx) => {
    await serializeOwner(tx, userId);
    const ctx = await loadOpenReview(tx, userId, reviewId);
    const { kind, occurredAt } = resolveKindAndTime(ctx, input);
    const f = ctx.fields;

    let openingId = input.openingId ?? null;
    if (openingId) {
      const { rows } = await tx.query(
        "SELECT 1 FROM job_openings WHERE id = $1 AND user_id = $2",
        [openingId, userId],
      );
      if (!rows[0]) throw new ActionError("NOT_FOUND");
    } else {
      const company = (input.company ?? f.company ?? "").trim();
      const title = (input.title ?? f.title ?? "").trim();
      if (!company || !title) throw new ActionError("INVALID_INPUT");
      const atsKey: AtsKey | null = f.atsKey;
      openingId = await insertOpening(tx, userId, {
        company,
        title,
        location: input.location ?? f.location,
        atsKey,
        canonicalUrl: f.canonicalUrl,
      });
    }
    const attemptId = await insertAttempt(tx, userId, openingId, {
      applicantEmail:
        input.applicantEmail !== undefined
          ? input.applicantEmail
          : f.applicantEmail,
      externalApplicationId:
        input.externalApplicationId !== undefined
          ? input.externalApplicationId
          : f.externalApplicationId,
      submittedAt: kind === "CONFIRMATION_RECEIVED" ? occurredAt : null,
      evidenceKey: ctx.evidenceKey,
      submissionEvidence: kind === "CONFIRMATION_RECEIVED",
    });
    await recordEvent(
      tx,
      {
        userId,
        attemptId,
        kind,
        occurredAt,
        sourceType: ctx.sourceKind,
        origin: "MANUAL",
        dedupeKey: `${attemptId}:${kind}:${ctx.evidenceKey}`,
        signalId: ctx.signalId,
        ...(kind === "INTERVIEW_SCHEDULED" && ctx.fields.calendar
          ? {
              calendar: ctx.fields.calendar,
              senderDomain: ctx.senderDomain ?? "",
            }
          : {}),
      },
      ctx.artifactId,
    );
    await closeReview(tx, userId, reviewId, ctx, "RESOLVED", "CREATED");
    // The new attempt may be what waiting updates were missing, as after an automatic one.
    await reconcileWaitingUpdates(tx, userId, new Date(), openingId);
    return { attemptId, openingId };
  });
}

export async function dismissReview(
  db: Db,
  userId: string,
  reviewId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await serializeOwner(tx, userId);
    const ctx = await loadOpenReview(tx, userId, reviewId);
    await closeReview(tx, userId, reviewId, ctx, "DISMISSED", "DISMISSED");
  });
}
