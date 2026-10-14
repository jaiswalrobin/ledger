import { EXTRACTOR_VERSION, extractSignal } from "./extract.ts";
import { classifyHeaders } from "./header-gate.ts";
import { hasSensitiveMessage } from "./privacy.ts";
import type { ExtractedFields, ExtractedSignal, ParsedMessage } from "./source.ts";

const COMPARED_FIELDS = ["company", "title", "location", "atsKey", "canonicalUrl", "applicantEmail", "externalApplicationId", "calendar"] as const;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical));
  if (value && typeof value === "object") return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return JSON.stringify(value ?? null);
};

/** Pure preview: no database, remote reads, event updates, or source-content output. */
export function previewExtraction(message: ParsedMessage, baseline?: { version: string; extract(message: ParsedMessage): ExtractedSignal }) {
  const gate = classifyHeaders({ from: `${message.fromName} <${message.fromAddress ?? ""}>`, subject: message.subject });
  if (gate.kind === "SKIP_SENSITIVE" || hasSensitiveMessage(message))
    return { status: "SKIPPED_SENSITIVE" as const };
  const after = extractSignal(message);
  const before = baseline?.extract(message) ?? null;
  const changes: { field: keyof ExtractedFields | "kind"; before: unknown; after: unknown }[] = [];
  if (before) {
    if (before.kind !== after.kind) changes.push({ field: "kind", before: before.kind, after: after.kind });
    for (const field of COMPARED_FIELDS)
      if (canonical(before.fields[field]) !== canonical(after.fields[field]))
        changes.push({ field, before: before.fields[field] ?? null, after: after.fields[field] ?? null });
  }
  return { status: "PREVIEW" as const, version: EXTRACTOR_VERSION, baselineVersion: baseline?.version ?? null,
    before, after, changes, requiresReview: !after.kind || !after.fields.company || !after.fields.title || after.confidence === "LOW" ||
      after.reasons.some(reason => ["conflicting-fields", "conflicting-alternatives", "interview-cancelled", "not-submitted", "uncertain-calendar", "quoted-history-only"].includes(reason)),
  };
}
