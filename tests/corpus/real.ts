/**
 * Evaluation on the user's own mail, kept on their machine. Emails are `.eml` files downloaded
 * from Gmail ("Show original" → "Download original") into a git-ignored folder, next to a
 * `labels.json` the user checks by hand.
 *
 * - label: adds an entry for each new email, pre-filled from the extractor and marked unverified.
 * - score: for verified entries, field metrics and rule attribution (as for the synthetic corpus),
 *   then every email runs through the real pipeline in date order on an in-memory database, and
 *   each labelled email's final state is compared with its label.
 *
 * Nothing leaves the folder. Output names files and extracted fields only, never message text.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { companyKey } from "../../src/domain/normalization.ts";
import { parseEml } from "../../src/ingestion/eml.ts";
import { extractSignal } from "../../src/ingestion/extract.ts";
import type { ParsedOriginal, SignalKind } from "../../src/ingestion/source.ts";
import { senderAuthenticated } from "../../src/server/gmail/authentication.ts";
import { drainReviewReconciliations, ingestOriginal } from "../../src/server/pipeline.ts";
import { loadOpenings } from "../../src/server/store.ts";
import { createTestDb, seedMailbox, seedUser } from "../helpers/db.ts";
import { scoreSignal, verdict, type Scored } from "./score.ts";

const KINDS: readonly SignalKind[] = [
  "CONFIRMATION_RECEIVED",
  "ASSESSMENT_INVITED",
  "INTERVIEW_INVITED",
  "INTERVIEW_SCHEDULED",
  "REJECTION_RECEIVED",
  "OFFER_RECEIVED",
];

export interface Label {
  /** Set to true once a person has checked every field. Only verified labels are scored. */
  verified: boolean;
  /** The event the email reports; null for mail that is not about an application. */
  kind: SignalKind | null;
  company: string | null;
  title: string | null;
  note?: string;
}

export type Labels = Record<string, Label>;

const LABELS = "labels.json";

/** Top-level header fields of a raw message, unfolded. Only used for Authentication-Results/From. */
export function topLevelHeaders(raw: Uint8Array): { name: string; value: string }[] {
  const text = new TextDecoder("latin1").decode(raw);
  const end = text.search(/\r?\n\r?\n/);
  const block = (end < 0 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  return block
    .split(/\r?\n/)
    .map((line) => /^([!-9;-~]+):[ \t]*(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ name: match[1]!, value: match[2]!.trim() }));
}

interface Email {
  file: string;
  original: ParsedOriginal;
  senderAuthenticated: boolean;
}

/** Each downloaded message once. Forwarded copies attached inside a message are not evaluated. */
async function loadEmails(dir: string): Promise<{ emails: Email[]; unreadable: string[] }> {
  const files = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".eml")).sort();
  const emails: Email[] = [];
  const unreadable: string[] = [];
  for (const file of files) {
    try {
      const raw = new Uint8Array(await readFile(join(dir, file)));
      const original = (await parseEml(raw)).find((candidate) => !candidate.isAttached);
      if (!original) throw new Error("no top-level message");
      emails.push({ file, original, senderAuthenticated: senderAuthenticated(topLevelHeaders(raw)) });
    } catch {
      unreadable.push(file);
    }
  }
  // Gmail sync and reconciliation both depend on order: ingest as the mail arrived.
  const at = (email: Email) => (email.original.message.date ? Date.parse(email.original.message.date) : Infinity);
  emails.sort((a, b) => at(a) - at(b) || a.file.localeCompare(b.file));
  return { emails, unreadable };
}

export async function readLabels(dir: string): Promise<Labels> {
  let text: string;
  try {
    text = await readFile(join(dir, LABELS), "utf8");
  } catch {
    return {};
  }
  const parsed = JSON.parse(text) as Record<string, Partial<Label>>;
  const labels: Labels = {};
  for (const [file, label] of Object.entries(parsed)) {
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
    if (label.kind != null && !KINDS.includes(label.kind)) throw new Error(`${file}: unknown kind ${label.kind}`);
    labels[file] = {
      verified: label.verified === true,
      kind: label.kind ?? null,
      company: text(label.company),
      title: text(label.title),
      ...(label.note ? { note: label.note } : {}),
    };
  }
  return labels;
}

/** Adds unverified, extractor-filled labels for new emails; existing labels are never changed. */
export async function labelEmails(dir: string): Promise<{ added: string[]; unverified: number; unreadable: string[] }> {
  const labels = await readLabels(dir);
  const { emails, unreadable } = await loadEmails(dir);
  const added: string[] = [];
  for (const { file, original } of emails) {
    if (labels[file]) continue;
    const signal = extractSignal(original.message);
    labels[file] = { verified: false, kind: signal.kind, company: signal.fields.company, title: signal.fields.title, note: "" };
    added.push(file);
  }
  const sorted = Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(join(dir, LABELS), `${JSON.stringify(sorted, null, 2)}\n`);
  return { added, unverified: Object.values(labels).filter((label) => !label.verified).length, unreadable };
}

/** Where an email ended up after the whole folder was processed. */
export type FinalState =
  | { status: "APPLIED"; events: { kind: string; company: string; title: string }[] }
  | { status: "REVIEW"; reason: string }
  | { status: "NO_SIGNAL" | "SKIPPED_SENSITIVE" | "DUPLICATE" | "ERROR" };

export type Judgement =
  /** Hiring mail applied to the right job with the right event. */
  | "applied-correctly"
  /** Any automatic change that does not match the label: the error Ledger must not make. */
  | "applied-wrongly"
  /** Hiring mail waiting for a person. */
  | "review"
  /** Not hiring mail, but a person is asked about it. */
  | "review-noise"
  /** Hiring mail that disappeared: dismissed or skipped as sensitive. */
  | "lost"
  /** Not hiring mail, and nothing happened. */
  | "ignored"
  /** Another copy of an email already processed. */
  | "duplicate"
  | "error";

export function judge(label: Label, state: FinalState): Judgement {
  if (state.status === "ERROR") return "error";
  if (state.status === "DUPLICATE") return "duplicate";
  if (!label.kind) return state.status === "APPLIED" ? "applied-wrongly" : state.status === "REVIEW" ? "review-noise" : "ignored";
  if (state.status === "REVIEW") return "review";
  if (state.status !== "APPLIED") return "lost";
  // Only fields the label names are compared: an update may not repeat the job title.
  const right = state.events.some(
    (event) =>
      event.kind === label.kind &&
      (!label.company || companyKey(event.company) === companyKey(label.company)) &&
      (!label.title || verdict(label.title, event.title) === "correct"),
  );
  return right ? "applied-correctly" : "applied-wrongly";
}

export interface RealReport {
  emails: number;
  verified: number;
  unreadable: string[];
  extraction: (Scored & { file: string })[];
  outcomes: { file: string; label: Label; state: FinalState; judgement: Judgement }[];
}

export async function evaluateReal(dir: string, observedAt = new Date()): Promise<RealReport> {
  const labels = await readLabels(dir);
  const { emails, unreadable } = await loadEmails(dir);
  const verified = emails.filter((email) => labels[email.file]?.verified);
  const extraction = verified.map(({ file, original }) => {
    const label = labels[file]!;
    return { file, ...scoreSignal(label, extractSignal(original.message)) };
  });

  const t = await createTestDb();
  try {
    const userId = await seedUser(t.db);
    const mailboxId = await seedMailbox(t.db, userId);
    const states = new Map<string, FinalState>();
    for (const email of emails) {
      try {
        const outcome = await ingestOriginal(t.db, {
          userId,
          source: { kind: "GMAIL", mailboxId, providerMessageId: email.file, senderAuthenticated: email.senderAuthenticated },
          original: email.original,
          observedAt,
        });
        if (outcome.status === "DUPLICATE" || outcome.status === "DUPLICATE_OBSERVATION")
          states.set(email.file, { status: "DUPLICATE" });
      } catch {
        states.set(email.file, { status: "ERROR" });
      }
    }
    // Reconciliation continues in bounded batches, as the scheduler would run it.
    for (let round = 0; round < 1000; round++) {
      const pending = await t.db.query("SELECT 1 FROM review_reconciliation_jobs LIMIT 1");
      if (!pending.rows.length) break;
      await drainReviewReconciliations(t.db, observedAt, 20);
    }

    const artifacts = await t.db.query<{
      file: string;
      decision: string;
      state: string | null;
      reason: string | null;
    }>(
      `SELECT a.provider_message_id AS file, a.body_access_decision AS decision, s.processing_state AS state,
              r.reason_code AS reason
         FROM source_artifacts a
         LEFT JOIN LATERAL (SELECT processing_state FROM extracted_signals
                             WHERE user_id = a.user_id AND source_artifact_id = a.id
                             ORDER BY created_at DESC LIMIT 1) s ON true
         LEFT JOIN LATERAL (SELECT reason_code FROM review_items
                             WHERE user_id = a.user_id AND source_artifact_id = a.id AND state = 'OPEN'
                             ORDER BY created_at DESC LIMIT 1) r ON true
        WHERE a.user_id = $1`,
      [userId],
    );
    const events = await t.db.query<{ file: string; kind: string; opening_id: string }>(
      `SELECT a.provider_message_id AS file, e.event_kind AS kind, t.job_opening_id AS opening_id
         FROM event_evidence ev
         JOIN source_artifacts a ON a.id = ev.artifact_id AND a.user_id = ev.user_id
         JOIN application_events e ON e.id = ev.event_id AND e.user_id = ev.user_id
         JOIN application_attempts t ON t.id = e.attempt_id AND t.user_id = e.user_id
        WHERE ev.user_id = $1 AND e.review_state = 'ACCEPTED'`,
      [userId],
    );
    const openings = new Map((await loadOpenings(t.db, userId)).map((opening) => [opening.id, opening]));
    for (const row of artifacts.rows) {
      if (states.has(row.file)) continue;
      const applied = events.rows
        .filter((event) => event.file === row.file)
        .map((event) => {
          const opening = openings.get(event.opening_id)!;
          return { kind: event.kind, company: opening.company, title: opening.title };
        });
      states.set(
        row.file,
        applied.length
          ? { status: "APPLIED", events: applied }
          : row.reason
            ? { status: "REVIEW", reason: row.reason }
            : row.decision === "SKIPPED_SENSITIVE"
              ? { status: "SKIPPED_SENSITIVE" }
              : row.state === "DUPLICATE"
                ? { status: "DUPLICATE" }
                : { status: "NO_SIGNAL" },
      );
    }
    const outcomes = verified.map(({ file }) => {
      const label = labels[file]!;
      const state = states.get(file) ?? { status: "ERROR" as const };
      return { file, label, state, judgement: judge(label, state) };
    });
    return { emails: emails.length, verified: verified.length, unreadable, extraction, outcomes };
  } finally {
    await t.close();
  }
}
