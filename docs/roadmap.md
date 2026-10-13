# Implementation roadmap

**Status:** Proposed sequencing, not delivery commitments.

## Phase 0 — Contract and fixtures

- [ ] Confirm product/domain invariants and decisions.
- [ ] Define shared **SourceArtifact**, **ExtractedSignal**, **ApplicationEvent** and **ResolutionResult** contracts.
- [ ] Create anonymized synthetic .eml fixtures: confirmations, OTP, interviews, offers, rejections, forwards, duplicates, ambiguous sender/recipient, multiple roles.
- [ ] Write golden tests for attempts and event status projections before Gmail API work.
- [ ] Choose NestJS vs Fastify, schema tooling and key management.

**Exit:** domain tests pass offline; no real mailbox access.

## Phase 1 — Domain persistence + headless parsing

- [ ] PostgreSQL schema/migrations with user-scope constraints and unique source keys.
- [ ] Event store + transactional read-model projection + correction/supersede path.
- [ ] Deterministic candidate parser + typed extraction signal contract; source versioning.
- [ ] Opening/attempt matching with review queue, not silent fuzzy merges.
- [ ] Safe .eml parser with size/depth limits and original-vs-envelope timestamp handling.

**Exit:** fixtures correctly reconstruct repeated application attempts; reprocessing is idempotent.

## Phase 2 — Dedicated Gmail synchronization

- [ ] Google OAuth for individual dedicated accounts; credential encryption and disconnect/revoke.
- [ ] Initial rolling 60-day backfill + progress/coverage states.
- [ ] Gmail header-first discovery and secret-suppression gate.
- [ ] Durable scheduled **history.list** incremental synchronization per mailbox.
- [ ] Recovery tests: retries, revoked tokens, Gmail 404 cursor, concurrent worker crash.
- [ ] Audit counters and sanitized logs.

**Exit:** two test accounts sync independently and recover without missing or duplicating durable events.

## Phase 3 — Minimal user interface

- [ ] Connections/sync-health dashboard.
- [ ] Opening list with attempts count and per-attempt evidence timeline.
- [ ] Explicit monitoring coverage, 60-day recent window and older actionable attempts.
- [ ] Review queue, reversible corrections, selective .eml forwarding instructions.
- [ ] Disconnect / delete workflows.

**Exit:** the end-to-end personal MVP can be used without manual row-entry for ordinary confirmed applications.

## Phase 4 — Hardening and evaluation

- [ ] Measure precision/recall against a broader corpus.
- [ ] Security reviews: cross-user access, MIME bombs, HTML injection, OAuth, log redaction, tokens.
- [ ] Assess legal and Google OAuth verification requirements before any public launch.
- [ ] Add production alerting and complete privacy disclosure/retention policies.

## Only after V1

- [ ] Browser extension on supported ATS confirmation pages, with proof of successful submission.
- [ ] Optional AI fallback after privacy review and benchmarking against deterministic rules.
- [ ] Targeted lookup for older attempts and optional longer backfills.
- [ ] Optional Gmail Pub/Sub push with watch renewal and periodic reconciliation.
- [ ] Follow-up recommendations and advanced analytics.

## Suggested initial work items

1. Source/email event JSON contracts and 25+ representative fixtures.
2. DB schema, migrations and domain projection tests.
3. .eml import worker with security limits.
4. Gmail connection and 60-day backfill.
5. history-list polling and recovery.
6. Initial dashboard and review workflow.

See [testing](testing.md) and [MVP scope](mvp.md).
