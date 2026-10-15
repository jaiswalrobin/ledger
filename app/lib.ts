import type { SyncResult } from "../src/server/gmail/sync.ts";
import type { Stage, Outcome } from "../src/domain/types.ts";
import type { AttemptView, OpeningView } from "../src/server/queries.ts";

export type Screen =
  | "applications"
  | "review"
  | "connections"
  | "import"
  | "settings";

export const label = (value: string) =>
  value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (x) => x.toUpperCase());

export function gmailMessageUrl(address:string|null,id:string|null):string|null {
  if(!address||!id||!/^[a-f0-9]{8,32}$/i.test(id)||!/^[^\s<>@]+@[^\s<>@]+$/.test(address))return null;
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(address)}#all/${id}`;
}

export const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "Unknown";

export const fullDate = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Unknown";

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "today", "yesterday", "3 days ago", "2 weeks ago" — never more precise than the evidence. */
export function relative(value: string | null, now = Date.now()): string {
  if (!value) return "Unknown";
  const days = Math.round((Date.parse(value) - now) / 86_400_000);
  if (Math.abs(days) < 14) return RELATIVE.format(days, "day");
  if (Math.abs(days) < 60) return RELATIVE.format(Math.round(days / 7), "week");
  return RELATIVE.format(Math.round(days / 30), "month");
}

export const daysSince = (value: string | null, now = Date.now()) =>
  value ? Math.max(0, Math.floor((now - Date.parse(value)) / 86_400_000)) : null;

export const localInstant = (value: string | null) => {
  if (!value) return "";
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};

export const plural = (n: number, word: string, many = `${word}s`) =>
  `${n} ${n === 1 ? word : many}`;

/** Deterministic, pleasant hue per company so a name is recognisable at a glance. */
export function hueFor(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (
    (words[0]?.[0] ?? "?") + (words.length > 1 ? (words[1]?.[0] ?? "") : "")
  ).toUpperCase();
}

// ---- journey ----------------------------------------------------------------------------

/** The status a person cares about for one attempt: its outcome once closed, else its stage. */
export const statusOf = (a: Pick<AttemptView, "stage" | "outcome">) =>
  a.outcome === "PENDING" ? a.stage : a.outcome;

export const JOURNEY: { key: Stage; name: string }[] = [
  { key: "APPLIED", name: "Applied" },
  { key: "ASSESSMENT", name: "Assessment" },
  { key: "INTERVIEW", name: "Interview" },
];

const STAGE_RANK: Record<Stage, number> = {
  UNKNOWN: 0,
  APPLIED: 1,
  ASSESSMENT: 2,
  INTERVIEW: 3,
};
export const stageRank = (stage: Stage) => STAGE_RANK[stage];

export type Bucket =
  | "unknown"
  | "applied"
  | "assessment"
  | "interview"
  | "offer"
  | "closed";
export function bucketOf(a: { stage: Stage; outcome: Outcome }): Bucket {
  if (a.outcome === "OFFERED") return "offer";
  if (a.outcome === "REJECTED" || a.outcome === "WITHDRAWN") return "closed";
  if (a.stage === "INTERVIEW") return "interview";
  if (a.stage === "ASSESSMENT") return "assessment";
  // A rejected confirmation leaves the stage UNKNOWN; never claim "Applied" for it.
  if (a.stage === "UNKNOWN") return "unknown";
  return "applied";
}

export const BUCKETS: { key: Bucket; name: string }[] = [
  { key: "unknown", name: "Unknown stage" },
  { key: "applied", name: "Applied" },
  { key: "assessment", name: "Assessment" },
  { key: "interview", name: "Interview" },
  { key: "offer", name: "Offer" },
  { key: "closed", name: "Closed" },
];

export function coverageOf(opening: OpeningView): {
  tone: "green" | "amber" | "quiet";
  text: string;
} {
  const all = (c: AttemptView["coverage"]) =>
    opening.attempts.every((a) => a.coverage === c);
  if (all("FORWARD_OR_MANUAL"))
    return { tone: "quiet", text: "Forwarded / manual" };
  if (all("CONTINUOUS_HEALTHY"))
    return { tone: "green", text: "Monitored · healthy" };
  return { tone: "amber", text: "Monitoring incomplete" };
}

export function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// ---- copy -------------------------------------------------------------------------------

export function syncNotice(runs: SyncResult[], recheck = false): string {
  if (runs.some((run) => run.status === "FAILED" || run.status === "DEGRADED"))
    return "Some emails could not be processed. Check the connection status and retry failed work.";
  if (runs.some((run) => run.status === "PARTIAL"))
    return "Some work remains. Use Sync now to continue; progress has been saved.";
  if (runs.some((run) => run.status === "BUSY"))
    return "A sync is already running. Refresh shortly to see its results.";
  if (!runs.length || runs.some((run) => run.status === "SKIPPED"))
    return "This connection was not synced. Check that Gmail is still connected.";
  return recheck
    ? "Recheck finished. Existing timelines and review decisions were preserved. Check the processing totals for excluded emails."
    : "Sync finished. Check the processing totals and review queue for emails that need attention.";
}

export const errorText: Record<string, string> = {
  SERVICE_UNAVAILABLE: "Ledger could not connect. Please try again shortly.",
  SIGN_IN_REQUIRED: "Your session expired. Sign in again to continue.",
  ORIGIN_REQUIRED: "Refresh the page and try again.",
  RATE_LIMITED: "Please wait a few minutes before trying again.",
  DEMO_ONLY:
    "Gmail connections are available when you sign in with your own account.",
  NOT_FOUND: "That item could not be found.",
  SYNC_BUSY:
    "A sync is already running. Wait for it to finish before rechecking.",
  RECHECK_IN_PROGRESS:
    "A recheck is already underway. Use Sync now to continue it.",
  INVALID_FORM: "Check the form fields and try again.",
  KIND_REQUIRED: "Choose an event type before saving this review.",
  INVALID_INPUT: "Choose a valid event type and date.",
  READ_ONLY_GRANT_REQUIRED: "Grant read-only Gmail access and reconnect.",
  DISCONNECT_FIRST: "Disconnect your mailboxes before deleting your account.",
  EMAIL_TOO_LARGE:
    "The email exceeds the safe import limits. Choose a smaller file.",
  UPLOAD_TOO_LARGE: "Choose up to five .eml files, totaling less than 3 MB.",
  CHOOSE_EMAIL_FILES: "Choose up to five .eml files, totaling less than 3 MB.",
};

export const reasonText: Record<string, string> = {
  NO_DATE: "The original message has no reliable date.",
  MISSING_JOB_DETAILS:
    "Some job details are missing. Add them before creating an application.",
  AMBIGUOUS_OPENING: "More than one job opening could match this message.",
  NO_KNOWN_SUBMISSION: "This update has no matching submission yet.",
  AMBIGUOUS_ATTEMPT:
    "We could not tell which application attempt this update belongs to.",
  POSSIBLE_RESENT_CONFIRMATION:
    "This may be another submission or a repeated confirmation.",
  TERMINAL_NEEDS_REVIEW:
    "This outcome needs stronger evidence before it changes your timeline.",
  UNRECOGNIZED: "This message needs your interpretation.",
  AMBIGUOUS_APPLICATION_ID:
    "This application ID appears on more than one attempt.",
  EVENT_PRECEDES_SUBMISSION: "This event appears to predate the submission.",
  CONFLICTING_EVENTS: "This update conflicts with the accepted timeline.",
  CONFLICTING_ALTERNATIVES:
    "The plain-text and HTML versions disagree. Choose how this update should be interpreted.",
  CONFLICTING_FIELDS: "This message names conflicting employers or roles. Choose the correct application details.",
  UNCERTAIN_CALENDAR: "The calendar invitation needs review before its time or status can be accepted.",
  CALENDAR_REVISION: "This calendar update is older than, or conflicts with, an accepted invitation.",
  INTERVIEW_CANCELLED:
    "This message says an interview was cancelled or postponed. Decide how it affects the timeline.",
  NOT_SUBMITTED:
    "This message mentions your application but says it was not submitted or not received.",
};

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(
    `/api/${path}`,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await res.json();
  if (!res.ok)
    throw new Error(
      errorText[data.error] ??
        "This action could not be completed. Check your selection and try again.",
    );
  return data as T;
}
