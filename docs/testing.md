# Test strategy and evaluation plan

**Status:** The original test plan. The automated suite now covers these layers: `npm run check`
(unit, pipeline and security tests on in-memory PostgreSQL), `npm run check:full` (adds real
PostgreSQL, build, browser and smoke tests), `npm run eval:parser` for the synthetic corpus, and
`npm run eval:real` for local evaluation on real mail. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## 1. Corpus and labels

Start with synthetic, consented or sanitized fixtures. Avoid committing real emails, OTPs, names, phone numbers, private links, Gmail tokens or recruiter correspondence to this **public** repository.

Label each sample with:
- **Is recruitment-related?** (yes/no/ambiguous)
- **Type** (confirmation, assessment, interview, rejection, offer, verification, unrelated)
- **Company/opening** canonical identifier, ATS tenant/requisition where available
- **Submission attempt** identifier or UNKNOWN
- **Submitted contact snapshot** (email/phone or UNKNOWN)
- **Expected accepted events**, chronology and expected review state
- **Safe-to-read-body?** (based on headers; annotate ambiguous sensitive cases)
- **Data source** (direct Gmail, forwarded .eml, duplicate, manual)

Use invented addresses and nonsensitive domains such as example.com; sanitize every sample.

## 2. Essential correctness cases

| ID | Input | Expected outcome |
| --- | --- | --- |
| ID-01 | Two emails, two confirmed submissions, same requisition | One opening, two attempts |
| ID-02 | Same Gmail address, two genuine submissions months apart | Two attempts if independently evidenced |
| ID-03 | Same ATS confirmation forwarded twice | One attempt, no duplicated accepted event |
| ID-04 | Two different requisition IDs, identical title | Two openings |
| ID-05 | Same requisition, alternate job-title spelling | Resolve by stable ATS ID |
| ID-06 | One mailbox receives forwarding for another applicant email | Preserve original application identity |
| ID-07 | Same phone on attempts A and B | Do not merge solely by phone |
| ID-08 | Rejection lacking identifying role | Review, no wrong terminal update |
| ID-09 | Interview email after a prior rejection on a different attempt | Correct attempt updated only |
| ID-10 | Late message for older-than-60-day attempt | Still process update |
| ID-11 | Unknown listing state | Do not assert opening is still active |
| ID-12 | Logged-in OTP from ATS provider | Skip classified content |
| ID-13 | Password-reset link hidden in benign-looking message | Redact if fetched; document remaining risk |
| ID-14 | Malformed nested .eml / huge attachment | Reject safely, no uncontrolled recursion |
| ID-15 | Forward envelope date differs from original date | Keep distinct times |
| ID-16 | Worker crashes before/after cursor commit | No silent work loss or duplicate |
| ID-17 | Gmail history 404 | Resync, gap visible, no fabricated completeness |
| ID-18 | Account disconnected | Coverage degraded; previously accepted history preserved unless deletion requested |
| ID-19 | User manually rejects incorrect assignment | Reprocessing must respect correction |
| ID-20 | Attacker accesses another user's artifact ID | Authorization denies access |

## 3. Test layers

- **Unit:** sender/subject candidate gates; secret patterns; MIME parser; normalization; validation; state projector; dedupe keys.
- **Property-based:** event replay idempotence, arbitrary ordering of observations, impossible cross-user references, random encoded MIME nesting.
- **Integration:** PostgreSQL transactions; worker leases; simultaneous mailbox runs; cursor advance after durable queue write; token revocation behavior.
- **End-to-end:** fake Gmail API replay + UI coverage/read model + imported .eml.
- **Security:** untrusted HTML, prompt injection, sensitive log scanning, CSRF/OAuth state, authorization, key handling and deletion.

## 4. Metrics

Track separately:
- **Discovery precision and recall:** correctly found submissions relative to labeled records.
- **Opening matching precision:** correct vacancy identity among matched samples.
- **Attempt matching precision:** correct submission among all proposed matches.
- **Terminal outcome precision:** accepted rejection/offer actually belongs to that attempt.
- **Review rate:** percentage of candidates needing manual resolution.
- **Operational reliability:** backfill completeness, sync lag, repeated job suppression, missing-message recovery.
- **Privacy:** full-body fetch ratio, sensitive-mail exclusion count and secret leakage in telemetry.

Never optimize headline accuracy alone; high precision with low recall can still miss most applications. Treat a small "zero mistakes" fixture set as necessary but insufficient for deployment.

## 5. Release criteria

- [ ] All invariant/edge-case tests pass.
- [ ] No known false automatic terminal outcomes in holdout fixtures; ambiguous cases go to review.
- [ ] No cross-user data access in integration tests.
- [ ] No plain credentials or email bodies in database/logs by default.
- [ ] Synced vs unsynced account state is unambiguous in the UI.
- [ ] Cursor loss, token expiry and job retries are exercised in fault-injection tests.
- [ ] OAuth scopes and privacy controls reviewed before using actual personal inbox data.

The test corpus should be continuously expanded with **user-approved, redacted regressions** for parsing bugs.
