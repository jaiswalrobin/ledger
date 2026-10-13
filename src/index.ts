export type * from "./domain/types.ts";
export { normalizeEmail, normalizedText, atsKeyId, canonicalUrlId } from "./domain/normalization.ts";
export { resolveOpening, resolveSubmission, resolveUpdate } from "./domain/resolution.ts";
export { projectAttempt } from "./domain/projection.ts";
export { classifyHeaders } from "./ingestion/header-gate.ts";
