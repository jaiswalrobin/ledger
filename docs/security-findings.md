# Security findings — first browser version

**Date:** 2026-10-13
**Branch / commits reviewed:** `feat/first-browser-version` — `440987f`, `33fdaaa`, `edb03ca`
**Status:** SEC-01 through SEC-09 have been remediated on the same branch, with regression tests. The browser layer now implements the SEC-13 controls. No public deployment or real-inbox access has been verified. The original audit below is retained as the baseline; its historical “Open” labels are superseded by the remediation record.
**Gate:** a synthetic browser preview can be deployed after database and hosting configuration. Before real inbox use, verify the live Google configuration and the remaining runtime, key-management, retention, and production-isolation limitations.

## Remediation record

- **SEC-01/02:** replaced backtracking HTML regexes with a bounded linear scanner;
  reject oversized bodies/headers before conversion, and never silently truncate
  potentially contradictory or sensitive content. Hostile-input tests complete within bounds.
- **SEC-03:** durable attempts/backoff are recorded before retrieval. Crashed tasks
  consume an attempt and eventually fail safely rather than blocking later mail.
- **SEC-04:** explicit `{ userId }` or authenticated internal `{ system: true }` scope;
  omission and cross-owner IDs fail closed. Routes derive owners from revocable sessions.
- **SEC-05:** retain completed discovery checkpoints and the original baseline until
  processing finishes; paginate incremental discovery durably within the budget.
- **SEC-06:** failed/pending work and stale sync observations prevent healthy coverage;
  surface failures and support explicit retries. Failed runs are recorded as failed.
- **SEC-07/08:** typed vault errors, settled worker pools, and ownership/expiry fencing
  for durable writes. Disconnect stops access locally first. Real PostgreSQL tests
  confirm that an old worker cannot ingest mail or release a replacement's lease.
- **SEC-09:** removed unknown-host canonical URLs and restricted known ATS URL shapes.
  React escapes all rendered content. No untrusted HTML is rendered or fetched.
- **SEC-13:** origin checks; bounded streamed uploads; opaque hashed sessions with
  expiry/logout revocation; OAuth state/purpose/user/nonce binding; exact read-only
  grants; bearer-only cron; CSP nonces and security headers; owner-scoped mutations.

Additional audit fixes: content-aware deduplication, employer/requisition-scoped
application-ID matching, candidate-ID exclusion, explicit submitted-contact proof,
secondary body-secret screening, no persisted raw Message-ID, chronology/conflict
review, serialized manual projection writes, accurate PGlite row counts, canonical
key validation, verified transport/time bounds, migration checksums/locking, and
seven-day demo retention. Uploaded sender headers cannot authorize terminal updates;
Gmail's server-supplied aligned authentication metadata plus a known ATS sender is
required for automatic terminal acceptance. Unknown recruiters and uploaded terminal
messages remain reviewable, and sender authentication is not a guarantee of extraction
correctness.

Evidence: `tests/review-regressions.test.ts`, `tests/web-security.test.ts`,
`tests/postgres/locking.test.ts`, `tests/browser/mvp.spec.ts`, plus the existing suite.
Local verification: **178 unit tests, 3 native PostgreSQL concurrency tests, and 5
production-browser scenarios passed**, along with type-checking, the production
build, migration/replay checks, and the synthetic domain demo. Browser checks ran
against a freshly migrated isolated database with browser security enabled;
repeated earlier runs exercised the demo rate limit. Remote CI is not yet confirmed.
A full dependency audit (including development dependencies) reports zero known
package vulnerabilities at the time of this review; this is not a claim of an exhaustive vulnerability guarantee. The
original external review reports have not been rerun by a separate security service.

Remaining launch work: actual Google/Vercel validation, runtime credential isolation,
production RLS, key rotation and backup expiry, broader extraction evaluation, and
any applicable Google restricted-scope verification. See `deployment.md`.

## 1. Where these findings came from

Two sources, kept separate on purpose.

1. **Automated background security reviews.** Two reviews ran after the commit and after the push. They reported **headlines only** — no file, line, reproduction or severity:

   | Review       | Headline as reported                                                                                                                                                  |
   | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | After commit | `authentication-bypass` in `src/server/gmail/sync.ts` · `fail-open-state-drift` in `src/server/gmail/sync.ts` · `redos-resource-cap-bypass` in `src/ingestion/eml.ts` |
   | After push   | `authentication-bypass / data-integrity` in `src/server/gmail/sync.ts` · `resource-bound-placement / ReDoS` in `src/ingestion/eml.ts`                                 |

2. **My own audit of those files**, done to find out what the headlines most plausibly refer to. Everything under "Evidence" below was read from the code or measured; nothing is copied from the reviews because the reviews gave no detail.

> **Caveat.** I mapped each headline to the code by reading it. If the reviewer meant something different from my mapping, the reviewer's full output is needed to confirm. SEC-01 to SEC-06 are the issues I could verify or reason through; SEC-07 onward are additional observations from the same audit.

Severity is **my assessment**, not the reviewer's, and is stated for the system as designed (single owner, Vercel + Neon, dedicated Gmail inbox).

## 2. Summary

| ID     | Title                                                                                       | Component                      | Severity                                    | Source                                | Status                        |
| ------ | ------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------- | ------------------------------------- | ----------------------------- |
| SEC-01 | Quadratic regexes in HTML→text conversion (ReDoS)                                           | `src/ingestion/eml.ts`         | **High**                                    | Review (ReDoS) + measured             | Open                          |
| SEC-02 | Resource caps applied after the expensive work                                              | `src/ingestion/eml.ts`         | **Medium**                                  | Review (resource-bound-placement)     | Open                          |
| SEC-03 | A hanging message is never counted, so it blocks a mailbox forever                          | `src/server/gmail/sync.ts`     | **High** (availability)                     | Own audit, follows from SEC-01        | Open                          |
| SEC-04 | Sync entry points have no caller-ownership scope; omission means "all users"                | `src/server/gmail/sync.ts`     | **High** if wired to a route (latent today) | Review (authentication-bypass)        | Open                          |
| SEC-05 | Interrupted discovery restarts and moves the baseline cursor forward (silent gap)           | `src/server/gmail/sync.ts`     | **Medium**                                  | Review (state drift / data-integrity) | Open                          |
| SEC-06 | A mailbox is reported `HEALTHY` and backfill `complete` despite permanently failed messages | `src/server/gmail/sync.ts`     | **Medium**                                  | Review (fail-open)                    | Open                          |
| SEC-07 | Token errors are classified by matching message text                                        | `src/server/gmail/sync.ts`     | Low                                         | Own audit                             | Open                          |
| SEC-08 | Lease can be released while workers are still running after an abort                        | `src/server/gmail/sync.ts`     | Low                                         | Own audit (reasoned, not reproduced)  | Open                          |
| SEC-09 | Attacker-influenced URL can be stored and later rendered as a link                          | `src/ingestion/extract.ts`     | Low–Medium                                  | Own audit                             | Open (UI not built yet)       |
| SEC-10 | The header gate is steerable by the sender                                                  | `src/ingestion/header-gate.ts` | Low (amplifies SEC-01)                      | Own audit / already documented        | Accepted, mitigate via SEC-01 |
| SEC-11 | Applicant email and redacted subject are stored unencrypted                                 | schema / `pipeline.ts`         | Info                                        | Own audit                             | Accepted for first test       |
| SEC-12 | The Gmail-credential boundary is a code boundary, not a runtime one                         | architecture                   | Info                                        | Design decision D7                    | Accepted, documented          |
| SEC-13 | Controls the web layer must satisfy before first deployment                                 | `app/` (not yet built)         | Gate                                        | Own audit                             | Checklist                     |

---

## 3. Findings

### SEC-01 — Quadratic regexes in HTML→text conversion (ReDoS) · High

**Location:** `src/ingestion/eml.ts`, `htmlToText`, lines 35–52. Four of its regexes backtrack quadratically on unterminated tags:

| Line | Pattern                                                          | Trigger                             |
| ---- | ---------------------------------------------------------------- | ----------------------------------- |
| 38   | `/<(script\|style\|head)\b[\s\S]*?<\/\1>/gi`                     | many `<script ` with no `</script>` |
| 39   | `/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi` | many `<a href="x">` with no `</a>`  |
| 40   | `/<(?:br\|\/p\|\/div\|\/tr\|\/li\|\/h[1-6])\b[^>]*>/gi`          | many `<br ` with no `>`             |
| 41   | `/<[^>]+>/g`                                                     | many `<` with no `>` (**worst**)    |

Each time the engine meets an opener it scans to the end of the string looking for a closer that does not exist, then moves on one character and repeats. Work grows with the square of the input.

**Evidence (measured on Node 26, this repository's code paths; throwaway scripts in the appendix):**

| Input                             | Size   | Time       |
| --------------------------------- | ------ | ---------- |
| `<` × 50 000 → line 41            | 50 KB  | 1.5 s      |
| `<` × 100 000                     | 100 KB | 5.8 s      |
| `<` × 200 000                     | 200 KB | 24.2 s     |
| `<` × 400 000                     | 400 KB | **97.3 s** |
| `<br ` × 80 000 → line 40         | 320 KB | 15.3 s     |
| `<script ` × 40 000 → line 38     | 320 KB | 1.7 s      |
| `<a href="x">` × 16 000 → line 39 | 192 KB | 0.2 s      |

Every doubling of input multiplies the time by about four, which is the signature of quadratic growth. Extrapolating line 41 to the 4 MB limit that `parseEml` allows gives on the order of **hours** of blocked CPU from one message. (The extrapolation is arithmetic, not a measurement.)

**How an attacker reaches it:**

1. **Gmail sync (the serious path).** Anyone who can send mail to the connected dedicated mailbox controls the subject and the HTML body. A subject containing a word from the header gate's list (for example "application") makes `classifyHeaders` return `CANDIDATE`, so `sync.ts` calls `getRaw` and then `parseEml`. The body only needs to be HTML-only, because `htmlToText` runs when `email.text` is empty (`eml.ts:63`). No authentication or user interaction is required.
2. **.eml upload.** Only the signed-in owner can reach it, so this is self-inflicted or accidental.

**Impact:** the regex runs synchronously, so it blocks the Node event loop. On Vercel the function instance stops serving other requests, the sync run exceeds the 300 s limit and is killed, and — see SEC-03 — the same message is picked up again on the next run.

**Recommended fix (in order of importance):**

1. Replace the four regexes with a **single-pass, linear scanner**: walk the string once, find tags with `indexOf`, bound the length of any single tag, skip `script/style/head` with one `indexOf("</script")` per opener (stop at end of input if not found), and track `<a href>` targets on a small stack. No lazy `[\s\S]*?` anywhere.
2. **Cap the HTML before converting it** (see SEC-02).
3. Keep the existing entity decoder (line 42) — it is linear.
4. Optional defence in depth: parse Gmail-sourced messages in a `worker_threads` worker with a hard timeout so that any future parser slowdown cannot stall the main loop.

**Verification:** regression tests that feed 300 000-repetition floods of `<script `, `<style>`, `<a href="…">`, bare `<` (2 000 000×) and `<!--` through `parseEml` and assert completion in under 1.5 s; plus a test that link targets are still kept and `script`/`style` content is still dropped. _(Drafted in the working tree, uncommitted, currently failing as intended.)_

**Status:** Open.

---

### SEC-02 — Resource caps applied after the expensive work · Medium

**Location:** `src/ingestion/eml.ts` lines 63–71 (`toMessage`), `EML_LIMITS`.

The only cap on body text, `maxTextChars` (100 000), is applied at line 71 — **after** `htmlToText` has already processed the entire HTML string. The sole input bound is the whole-file limit (`maxBytes`, 4 MB), which is large enough to make SEC-01 catastrophic. Header-derived strings are also unbounded up to the parser's 256 KB header budget: `subject` (line 69) and `fromName` (line 66) flow into `classifyHeaders`, `extractSignal` and `redactSubject`, which all run regexes over them.

**Impact:** a cap that is checked after the cost has been paid does not protect anything. It also means a large subject multiplies work in every later stage.

**Recommended fix:**

- Slice the HTML to a fixed size **before** conversion (suggest 256 KB — real job emails are far smaller) and the plain-text part to `maxTextChars` before any processing.
- Cap `subject` at 1 000 characters, `fromName` at 200, and the number of `To` recipients at 50, at the point they are read from the parser.
- Keep `maxBytes`, but treat it as a ceiling, not the working bound.

**Verification:** tests that a 100 000-character subject is truncated to ≤ 1 000, that a multi-megabyte `<p>` body returns ≤ `maxTextChars` quickly, and that cap values are enforced at the boundary function. _(Drafted, uncommitted.)_

**Status:** Open.

---

### SEC-03 — A hanging message is never counted, so it blocks a mailbox forever · High (availability)

**Location:** `src/server/gmail/sync.ts` — `retry` (line 229), `processTask` (line 241) and the due-task query ordered by `created_at` (line 289).

A task's `attempts` counter is incremented only inside `retry()`, which runs only when `processTask` **catches** an error. If processing never returns (SEC-01) or the process is killed (timeout, out-of-memory), no `catch` runs: the task stays `PENDING` with `attempts = 0` and `next_attempt_at` unchanged. The next run picks it up first (tasks are ordered by `created_at`) and hangs again. The lease only expires after 330 s, so each run wastes its whole budget and **no other message in that mailbox is ever processed**.

This is a general poison-pill weakness, not specific to HTML: any input that crashes or stalls the worker has the same effect.

**Impact:** one crafted email permanently halts a mailbox's sync; the UI would show a mailbox that is "syncing" but never progressing.

**Recommended fix:** count the attempt **when claiming** the task, before doing any work — `UPDATE processing_tasks SET attempts = attempts + 1, next_attempt_at = now() + backoff(attempts + 1) WHERE id = …` — and mark `DONE`/`FAILED` on completion. A crash then still consumes an attempt, and after `MAX_TASK_ATTEMPTS` the task becomes `FAILED` with a safe code (`CRASHED_OR_TIMED_OUT`) instead of blocking the queue. Process due tasks oldest-first but never let one task monopolise a run.

**Verification:** a test where `getRaw`/`parseEml` is made to hang or throw non-Error values and the fake clock advances between runs; assert the task reaches `FAILED` within the attempt bound and other messages still process. _(Not yet drafted.)_

**Status:** Open.

---

### SEC-04 — Sync entry points have no caller-ownership scope · High if wired to a route (latent today)

**Location:** `src/server/gmail/sync.ts` — `syncMailbox` (line 73), the lease `UPDATE` (lines 80–85), and `syncAllMailboxes` (lines 329–334).

1. `syncMailbox(deps, mailboxId)` looks the mailbox up **by id only**. The lease statement filters on `id` and `sync_state` and has no `user_id` predicate, and the function takes no caller identity. Any code path that passes a client-supplied mailbox id would let one user trigger — and burn Gmail quota for — another user's mailbox (insecure direct object reference). Internally the mailbox's own `user_id` is used consistently afterwards, so data is not mixed, but the **authorization decision is missing at the entry point**.
2. `syncAllMailboxes(deps, userId?)` treats a missing `userId` as "every user" (`$1::uuid IS NULL OR user_id = $1::uuid`, bound to `userId ?? null`). A session lookup that returns `undefined` (a bug, an expired session on a route that forgot to check) silently turns "sync my mailboxes" into "sync everyone's". This is a **fail-open default** for an authorization parameter.

No route calls these functions yet, which is why this is rated latent. It becomes High the moment a "Sync now" action or cron route is wired up carelessly — and the code as written invites exactly that.

**Recommended fix:** make the scope explicit and non-optional:

```ts
type SyncScope = { userId: string } | { system: true }; // no default
syncMailbox(deps, mailboxId, scope); // lease UPDATE adds AND ($user IS NULL OR user_id = $user)
syncAllMailboxes(deps, scope);
```

User-initiated paths pass `{ userId: session.userId }`; only the bearer-authenticated cron route passes `{ system: true }`. A mismatch returns `SKIPPED` without touching Gmail.

**Verification:** a user-scoped sync of another user's mailbox returns `SKIPPED` with zero Gmail calls and leaves state unchanged; a user-scoped sweep touches only that user's mailboxes while the system scope touches all. _(Drafted, uncommitted.)_

**Status:** Open.

---

### SEC-05 — Interrupted discovery restarts and moves the baseline cursor forward · Medium (data integrity)

**Location:** `src/server/gmail/sync.ts` — `discover` (lines 138–155), the state dispatch (lines 194–198) and the final state transition (lines 303–304).

Trace:

1. First run on a new mailbox (`INITIALIZING`): `discover("BACKFILL")` records baseline history id **B1**, lists the 60-day window, and — on the last page — sets `scan_state = NULL`. Then `catchUp()` advances the cursor to the latest id **L**.
2. Draining the work queue ends early (time budget, crash, or retries still pending). The mailbox is still `INITIALIZING` and `scan_state` is `NULL`.
3. Next run: because the state is still `INITIALIZING`, the dispatcher calls `discover("BACKFILL")` again. `scan` is `NULL`, so line 139 is true and the function **calls `getProfile()` again and overwrites `history_cursor` with a new baseline B2 ≥ L** (lines 146–154). It also overwrites `backfill_start`/`backfill_end`.
4. Messages that arrived between L and B2 are now found only if the broad search queries match them. The history catch-up that would have caught anything — regardless of subject — starts from B2 and never sees them. Anything the queries miss is **permanently skipped, and nothing records that a gap exists.**

The same restart happens for `RESYNC_REQUIRED`.

**Impact:** silent loss of mail from the monitored mailbox, while the UI reports a healthy, complete backfill. This directly contradicts product rule 5 ("unobserved is not unanswered") and the docs' requirement never to silently skip a gap (`ingestion.md` §5).

**Recommended fix:** persist that discovery **finished** (for example `scan_state = {mode, done: true}`), and on later runs skip `discover` when it is present and go straight to `catchUp()` from the stored cursor. Only the very first call may set the baseline, and it must never be overwritten while the mailbox is mid-initialisation. Clear `scan_state` only when the mailbox becomes `HEALTHY`.

**Verification:** run once with a zero time budget (discovery completes, processing does not), then add a new message and run again; assert `listMessageIds` and `getProfile` are not called again, the baseline is unchanged, and the new message is found through history. _(Drafted, uncommitted.)_

**Status:** Open.

---

### SEC-06 — Mailbox reported `HEALTHY` and backfill `complete` despite failed messages · Medium

**Location:** `src/server/gmail/sync.ts`, lines 299–307.

The transition to `HEALTHY` (and `backfill_complete = true`) checks only that no tasks are `PENDING`. Tasks that exhausted their retries are `FAILED`, so they are not counted. Line 304 also sets `last_error_code = NULL` and line 306 clears it on every healthy run, erasing any trace.

**Impact:** a mailbox with permanently unprocessed messages shows "Monitored · healthy" with a complete backfill. The product's coverage promise ("explicit coverage; do not claim exhaustive history", `ingestion.md` §8) is violated, and the owner cannot tell that some mail was never read.

**Recommended fix:** count `FAILED` tasks (excluding the deliberate `DISCONNECTED` ones). If any exist, keep `backfill_complete = false`, set `last_error_code = 'TASKS_FAILED'` and do **not** clear it on healthy runs; show the count on the Connections page and offer a manual "retry failed" action.

**Verification:** a mailbox with one message that can never be fetched reaches `HEALTHY` but with `backfill_complete = false` and `last_error_code = 'TASKS_FAILED'`. _(Drafted, uncommitted.)_

**Status:** Open.

---

### SEC-07 — Token errors are classified by matching message text · Low

**Location:** `src/server/gmail/sync.ts`, lines 107–109 (`unreadable`).

Whether a failure from the client factory means "the stored token is unreadable, degrade the mailbox" is decided by regex-matching the error message (`/TOKEN_FORMAT|authenticate|unsupported state/`). Messages are not a stable contract: a library upgrade changes them, and an unrelated error that happens to contain "authenticate" would flip a healthy mailbox to `DEGRADED`.

**Recommended fix:** have the vault throw a dedicated `TokenUnreadableError` class, and test with `instanceof`.

**Status:** Open.

---

### SEC-08 — Lease can be released while workers are still running · Low

**Location:** `src/server/gmail/sync.ts`, the worker pool (`Promise.all`, line 294) and the `finally` block (line 318).

If one worker throws `AuthAbort`, `Promise.all` rejects immediately while the other workers keep running. The `finally` block then releases the lease and writes counters while those workers may still be writing task and event rows. A new run could start concurrently. All writes are idempotent (unique task keys, event dedupe keys, per-user lock in the pipeline), so the likely effect is inaccurate counters rather than corruption. **This was reasoned from the code and not reproduced.**

**Recommended fix:** use `Promise.allSettled`, wait for every worker, then rethrow the first abort.

**Status:** Open.

---

### SEC-09 — Attacker-influenced URL can be stored and later rendered as a link · Low–Medium

**Location:** `src/ingestion/extract.ts`, `genericJobUrl`; stored in `job_openings.canonical_url`.

Known ATS hosts are matched by exact host and path shape, which is safe. The generic fallback, however, accepts **any** `https` URL whose path contains a segment such as `jobs` or `careers` and no segment longer than 40 characters. A message can therefore plant `https://attacker.example/jobs/apply` into the owner's dashboard. When the UI renders `canonicalUrl` as a link, that is a phishing vector from the owner's own trusted app. The web layer does not exist yet, so nothing is exposed today.

**Recommended fix:** only render a clickable link for URLs on the known-ATS host allowlist; show other URLs as plain text with the host highlighted, never as `<a>`. For any link rendered, require `https:`, and set `rel="noopener noreferrer nofollow"`. Add a UI test for it when the page is built.

**Status:** Open (preventive; UI not built).

---

### SEC-10 — The header gate is steerable by the sender · Low

**Location:** `src/ingestion/header-gate.ts`.

Whether a body is fetched depends on keywords in headers that the sender controls, so an attacker can _cause_ a body fetch (this is what makes SEC-01 reachable) and can also craft a subject to look like a verification mail. The docs already state the gate is "not a security guarantee". This is accepted by design; the mitigation is that everything after the gate must be safe on hostile input (SEC-01, SEC-02, SEC-03).

**Status:** Accepted; mitigated by closing SEC-01 to SEC-03.

---

### SEC-11 — Applicant email and redacted subject stored unencrypted · Info

`application_attempts.applicant_email_snapshot` and `extracted_signals.fields` hold the applicant email in plaintext, and `source_artifacts.subject_redacted` holds a subject after heuristic redaction (links, long digit runs and token-shaped strings), which will not remove personal names or every secret. No message bodies, headers or phone numbers are stored. This is acceptable for a single-owner test on a dedicated inbox. Before wider use: decide column-level encryption, retention and deletion (open decision #4 in `decisions.md`).

**Status:** Accepted for the first test.

### SEC-12 — The Gmail-credential boundary is a code boundary · Info

The architecture asks that only the Gmail connector can use Gmail credentials, enforced "by code/package interfaces **and** runtime permissions". On a single Vercel app only the first half is possible: `tests/security.test.ts` fails the build if anything outside `src/server/gmail/` references `decryptToken`, but all code runs in one process with access to the same environment variables, so a code-execution bug anywhere would reach the key. Accepted and recorded as design decision D7.

**Status:** Accepted; revisit if the app is split into separate runtimes.

---

## 4. SEC-13 — Controls the web layer must satisfy before first deployment

The `app/` layer is not built yet, so these are requirements rather than findings. They come from the project docs and the Next.js 16 security guidance in `node_modules/next/dist/docs`.

- [ ] **Cron endpoint fails closed.** `/api/cron/sync` accepts only `Authorization: Bearer <CRON_SECRET>`, compared in constant time; the route refuses to run if the secret is unset or shorter than 24 characters (the config parser already enforces the length). Uses the explicit `{ system: true }` sync scope (SEC-04).
- [ ] **Every Server Action re-verifies the session** and re-checks resource ownership in SQL. A page-level check does not protect an action (Next.js data-security guide). All mutations already take `userId` in their `WHERE` clauses; the actions must pass the _session_ user, never a form value.
- [ ] **CSRF.** Server Actions compare `Origin` to `Host` by default; do not add `allowedOrigins`. OAuth callbacks verify `state` in constant time and bind a Gmail connection to the session user (implemented and tested in `src/server/security/flow.ts`).
- [ ] **Cookies:** `HttpOnly`, `Secure` (HTTPS), `SameSite=Lax`, short TTL; the OAuth state cookie scoped to `/api` and 10 minutes.
- [ ] **No secrets in logs or responses.** Error paths return codes only; no `console.*` in `src/server` (enforced by a test). Verify the same for `app/`.
- [ ] **Upload limits** enforced in the action (4 MB) before reading the body, with an explicit error, because Vercel rejects larger bodies with a generic 413.
- [ ] **Rendering:** React escaping only, no `dangerouslySetInnerHTML`; links per SEC-09.
- [ ] **Security headers** (`frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy`).
- [ ] **Google OAuth app** in _Testing_ mode with only the owner's accounts as test users; scope exactly `gmail.readonly` (validated server-side by `grantedScopesAreReadOnly`).

## 5. Remediation plan

| Step                                                                    | Closes         | Notes                                                             |
| ----------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------- |
| 1. Linear HTML scanner + input caps at the parse boundary               | SEC-01, SEC-02 | Highest value; makes SEC-10 harmless.                             |
| 2. Claim-time attempt accounting                                        | SEC-03         | Removes the poison-pill class of failure.                         |
| 3. Explicit `SyncScope`                                                 | SEC-04         | Small change, do it before any route calls sync.                  |
| 4. Persist discovery completion; never rewrite the baseline             | SEC-05         |                                                                   |
| 5. Count failed tasks in health and coverage                            | SEC-06         | Surface on the Connections page.                                  |
| 6. Typed token errors; `allSettled` worker pool                         | SEC-07, SEC-08 |                                                                   |
| 7. Link allowlist in the UI                                             | SEC-09         | When the Opening page is built.                                   |
| 8. Re-run the full suite, then re-request the automated security review | all            | The reviewer's full output should be compared with this document. |

**Historical note:** this paragraph previously described uncommitted failing drafts. The implemented regression tests and remediations are now part of this branch; use the remediation record above for current status.

## Appendix — reproducing the ReDoS measurements

Throwaway scripts, not part of the repository. They copy the regexes from `src/ingestion/eml.ts` lines 38–41 and time `String.prototype.replace` on synthetic input. Run with `node --experimental-strip-types`.

```ts
const script = /<(script|style|head)\b[\s\S]*?<\/\1>/gi; // eml.ts:38
const anchor = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi; // :39
const breaks = /<(?:br|\/p|\/div|\/tr|\/li|\/h[1-6])\b[^>]*>/gi; // :40
const strip = /<[^>]+>/g; // :41

const time = (label: string, input: string, re: RegExp) => {
  const t = process.hrtime.bigint();
  input.replace(re, " ");
  console.log(
    label,
    input.length,
    "chars",
    Number(process.hrtime.bigint() - t) / 1e6,
    "ms",
  );
};

for (const n of [50_000, 100_000, 200_000, 400_000])
  time(`'<' x ${n}`, "<".repeat(n), strip);
for (const n of [20_000, 40_000, 80_000])
  time(`'<br ' x ${n}`, "<br ".repeat(n), breaks);
for (const n of [10_000, 20_000, 40_000])
  time(`'<script ' x ${n}`, "<script ".repeat(n), script);
for (const n of [4_000, 8_000, 16_000])
  time(`'<a href="x">' x ${n}`, '<a href="x">'.repeat(n), anchor);
```

Expect each row to take about four times as long as the row before it. After the fix, the same inputs must complete in well under a second.
