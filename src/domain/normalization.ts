import type { AtsKey } from "./types.ts";

/** Deliberately limited normalization; do not guess at Gmail aliases or country dial codes. */
export function normalizeEmail(email: string | null): string | null {
  const value = email?.trim().toLowerCase();
  return value || null;
}

export function normalizedText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
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
