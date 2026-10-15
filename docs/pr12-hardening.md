# PR #12 hardening decisions

The rules-9 changes preserve accepted evidence and owner decisions while improving extraction,
resolution and operational recovery. No production data is rewritten by an extractor version bump.

| Feedback | Implemented behavior |
| --- | --- |
| MIME alternatives overwrite ambiguous fields | Symmetric ambiguity propagation, consistent fields/decisions, deduplicated alternatives; calendar extraction runs once per original. |
| Calendar times, repeated revisions and stale signal joins | Typed accepted calendar facts, exact signal/artifact/owner provenance, verified issuer and identity checks; latest accepted schedule drives detail and agenda. |
| Early sign-offs hide the remainder | Bounded signature handling preserves later structured facts; quote blocks and authored replies have separate regions. |
| Sender evidence arrives after subject splitting; company/title mismatches | Collect sender/signature first, use normalized comparisons, bind prose role/employer pairs, and keep credible contradictions in review. |
| Extractor upgrades expose historical proposals | Accepted evidence links reference exact signal versions; calendar resolution never reads arbitrary artifact proposal history. |
| Manual resolution misses domain bookkeeping | Shared submission-fact updates and reconciliation after automatic or reviewed confirmations; nonreceipt updates never become submission evidence. |
| Task bookkeeping serializes every worker on one user row | Mailbox-only bookkeeping locks, owner-before-mailbox locks for domain writes, and native PostgreSQL concurrency coverage. |
| Killed invocations leave RUNNING audit records | Budget checks before each task, durable counters/cursors, fenced lease replacement and abandoned-run recovery on the next lease. |
| Full-history reads and unbounded review scans | Scoped opening queries, five batched mailbox queries, and 25-item per-opening reconciliation with durable scheduled continuation. |
| Follow-ups omit title/contact; reviews lack useful context | Verified accepted conversation/employer context, contradiction checks, safe field candidate controls and Gmail source links. |
| Scheduled interviews are invisible on the dashboard | Upcoming times derive from current accepted revisions and disappear when rejected or the attempt closes. |

Several proposed remedies deliberately remain different:

- Support weights are heuristic. A score ratio does not override another credible explicit
  company/title assertion; region parsing and role bindings address spurious evidence.
- Later calendar revisions do not erase or automatically mark accepted historical evidence
  SUPERSEDED. The current schedule is a separate projection, and owner rejection is reversible.
- Raw body excerpts are not stored. Sanitized facts, candidates and source links provide review
  context while preserving the existing data-minimization contract.
- Receiving mailbox addresses are not inferred submitted contacts. Silence and lack of an observed
  outgoing reply do not prove rejection, an incomplete assessment or an unanswered invitation.

Separate worker hosting, runtime credential isolation and cancellation across every dependency
remain deployment work. The current implementation uses bounded HTTP-triggered runners backed by
durable PostgreSQL work. URL-only quick logging and task-completion tracking need a separate product
contract: a saved job URL alone must never assert an actual submission or an outstanding action.

Validation covers malformed/quoted HTML, sign-offs, polarity and MIME mutations; persisted review
outcomes; exact accepted provenance; calendar identity and agenda projections; conversation and
contact contradictions; native PostgreSQL locks; bounded reconciliation; and browser import/reversal.
Development/holdout parser evaluations are synthetic and do not establish accuracy on real inboxes.
