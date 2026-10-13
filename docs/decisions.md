# Architecture decisions and unresolved questions

**Documented:** 2026-10-13. **Status:** Proposed design baseline; revisit as real fixtures and Gmail API tests provide evidence.

| ID | Decision | Rationale | Status |
| --- | --- | --- | --- |
| ADR-001 | Separate job opening from submission attempts | One vacancy can have repeated independently tracked submissions | Baseline |
| ADR-002 | Snapshot submitted email and phone for each attempt | Applicant contact differs from connected inbox; numbers can be reused | Baseline |
| ADR-003 | Do not equate a second identity with a new ATS candidate | Employer matching rules are unknown | Baseline |
| ADR-004 | Dedicated job mailboxes for continuous sync | Reduce privacy exposure compared with connecting primary personal inbox | Baseline |
| ADR-005 | Primary inbox ingested by selected forwarded .eml only | Avoid broad OAuth access to sensitive primary mailbox | Baseline |
| ADR-006 | Initial 60-day backfill, all-time ongoing tracking | Limit initial work without discarding old relevant activity | Baseline |
| ADR-007 | Evidence-backed domain events and corrections | Auditability, out-of-order messages, recoverable false matches | Proposed |
| ADR-008 | PostgreSQL modular monolith + durable worker | Simple, transactional, sufficient for expected initial scale | Proposed |
| ADR-009 | Rules-based parsing first; no external LLM content transfer in V1 | Lower cost, fewer secrets crossing boundaries | Proposed |
| ADR-010 | Scheduled polling first; Gmail push optional later | Smaller initial cloud/operational surface | Proposed |
| ADR-011 | Do not keep full message bodies | Data minimization, reduced breach impact | Proposed |

## Trade-off: 60-day import vs historical completeness

A two-month import cannot guarantee historical completeness. Preserve **per-mailbox scan coverage** and allow manual forwarded imports, targeted historical lookup and optional extended backfills. A status like "no reply" must be qualified by which sources are monitored.

## Trade-off: Gmail automation vs mailbox isolation

Full automatic detection requires read-only Gmail access, which grants broad mailbox capability despite Ledger's own filtering. Dedicated mailboxes reduce exposure but do not make it safe to ingest OTPs or reset links. Explicit .eml forwarding from personal mail provides stronger source selection, at the cost of manual forwarding for later updates.

## Trade-off: matching confidence vs effortless UX

False merges can apply a rejection to the wrong application; false splits can clutter results. Prefer review for ambiguous terminal events. Validate thresholds with fixtures rather than choosing an arbitrary model confidence score.

## Decisions still to make before code or launch

1. **Backend choice**: NestJS or Fastify with a small DI/module layer.
2. **Database schema tooling**: Drizzle/Prisma/Kysely, migrations and RLS strategy.
3. **Deployment and key management**: provider choice, encryption design, rotation, backups.
4. **Data deletion/retention**: exact lifecycle for evidence on mailbox disconnect, backup expiry and account deletion.
5. **Gmail OAuth path**: personal prototype vs verified public app; restricted-scope review and assessment.
6. **Source explanation UX**: link to original mailbox message vs store bounded redacted evidence excerpt.
7. **Phone matching policy**: strict user-confirmed normalization country, encryption and keyed HMAC matching.
8. **Release targets**: size/diversity of evaluation corpus and precision/recall thresholds.
9. **Open/closed listing checks**: defer verification provider design outside V1.
10. **Handling backfill of sent application emails**: measure utility, privacy cost and duplicates.

## Change protocol

Each meaningful change to domain identity, Gmail access, event state, retention or trust boundaries should be added here with: problem, decision, alternative, known drawback, evidence and date. This table is a seed, not a claim that every proposal has been approved.
