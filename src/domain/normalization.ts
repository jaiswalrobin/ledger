import type { AtsKey } from "./types.ts";

/** Deliberately limited normalization; do not guess at Gmail aliases or country dial codes. */
export function normalizeEmail(email: string | null): string | null {
  const value = email?.trim().toLowerCase();
  return value || null;
}

export function normalizedText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Legal-form suffixes that do not distinguish one employer from another. */
const LEGAL_SUFFIX =
  /[\s,]+(?:inc|incorporated|llc|l\s?l\s?c|ltd|limited|corp|corporation|co|plc|llp|lp|gmbh|ag|sa|sas|srl|spa|bv|nv|oy|ab|kk|pty|pte|holdings?)$/;

/**
 * Comparison key for an employer name. "Acme", "ACME", "Acme, Inc." and "The Acme Co." are the
 * same employer; "Acme" and "Acme Robotics" are not (a prefix is never enough). The display name
 * is kept as written; only comparisons use the key.
 */
export function companyKey(value: string): string {
  let key = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.'’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the\s+/, "");
  for (let i = 0; i < 2; i++) {
    const stripped = key.replace(LEGAL_SUFFIX, "").trim();
    if (!stripped) break;
    key = stripped;
  }
  return key || normalizedText(value);
}

export function atsKeyId(key: AtsKey): string {
  // JSON prevents separator collisions, e.g. "|" inside tenant identifiers.
  return JSON.stringify([
    normalizedText(key.provider),
    normalizedText(key.tenant),
    key.requisitionId.trim(),
  ]);
}

/**
 * Compare only pre-approved canonical URLs. Preserve meaningful query params:
 * many ATS systems place the job ID in the query string.
 * Tracking/query redaction belongs to the ingestion boundary.
 */
export function canonicalUrlId(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}
