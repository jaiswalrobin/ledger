import { EXTRACTOR_VERSION, extractSignal, isHiringSignal } from "./extract.ts";
import { classifyHeaders } from "./header-gate.ts";
import { messageSensitivity } from "./privacy.ts";
import type { ExtractedFields, ExtractedSignal, ParsedMessage } from "./source.ts";

type Extractor = { version: string; extract(message: ParsedMessage): ExtractedSignal };

const COMPARED_FIELDS = [
  "company",
  "title",
  "location",
  "atsKey",
  "canonicalUrl",
  "applicantEmail",
  "externalApplicationId",
  "calendar",
] as const;

/** Extractor reasons the pipeline always sends to a person. */
const REVIEW_REASONS: ReadonlySet<string> = new Set([
  "conflicting-fields",
  "conflicting-alternatives",
  "interview-cancelled",
  "not-submitted",
  "uncertain-calendar",
  "quoted-history-only",
]);

/** Key-order-independent JSON, so {a,b} and {b,a} compare equal. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical));
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify(entries.map(([key, item]) => [key, canonical(item)]));
  }
  return JSON.stringify(value ?? null);
};

function changesBetween(before: ExtractedSignal, after: ExtractedSignal) {
  const changes: { field: keyof ExtractedFields | "kind"; before: unknown; after: unknown }[] = [];
  if (before.kind !== after.kind) changes.push({ field: "kind", before: before.kind, after: after.kind });
  for (const field of COMPARED_FIELDS)
    if (canonical(before.fields[field]) !== canonical(after.fields[field]))
      changes.push({ field, before: before.fields[field] ?? null, after: after.fields[field] ?? null });
  return changes;
}

const needsReview = (signal: ExtractedSignal): boolean =>
  !signal.kind ||
  !signal.fields.company ||
  !signal.fields.title ||
  signal.confidence === "LOW" ||
  signal.reasons.some((reason) => REVIEW_REASONS.has(reason));

/** Pure preview: no database, remote reads, event updates, or source-content output. */
export function previewExtraction(message: ParsedMessage, baseline?: Extractor) {
  const from = `${message.fromName} <${message.fromAddress ?? ""}>`;
  const level = messageSensitivity(message);
  const after = extractSignal(message);
  // The same rule as the pipeline: credential deliveries, and access links outside hiring mail.
  if (
    classifyHeaders({ from, subject: message.subject }).kind === "SKIP_SENSITIVE" ||
    level === "CREDENTIAL" ||
    (level === "ACCESS_LINK" && !isHiringSignal(after))
  )
    return { status: "SKIPPED_SENSITIVE" as const };
  const before = baseline?.extract(message) ?? null;
  return {
    status: "PREVIEW" as const,
    version: EXTRACTOR_VERSION,
    baselineVersion: baseline?.version ?? null,
    before,
    after,
    changes: before ? changesBetween(before, after) : [],
    requiresReview: needsReview(after),
  };
}
