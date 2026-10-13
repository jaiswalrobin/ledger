# MVP scope and acceptance criteria

**Status:** Proposed baseline for V1; success metrics must be measured before promising production reliability.

## Problem and north-star

A person applies to roles through several email identities and loses visibility because confirmations, screening invites and rejections are scattered or absent. Ledger should reconstruct the history with **minimal manual work**, while being transparent about the limits of email evidence.

**North-star:** Percentage of verifiable application events correctly attributed to the right **opening and submission attempt**, with minimal human corrections and no silent false terminal outcomes.

## In scope (V1)

- [ ] Tracker user login separate from Gmail authorization.
- [ ] Connect/disconnect **two or more** dedicated Gmail accounts independently with read-only permission.
- [ ] Rolling **60-day initial backfill** per mailbox; expose partial/completed coverage.
- [ ] Recurring per-mailbox incremental sync and recovery after token errors or cursor expiration.
- [ ] Header-first message selection; avoid processing obvious OTP/reset/login mail.
- [ ] Parse representative ATS confirmations, assessment/interview invitations, rejection and offer messages.
- [ ] Distinguish company, job opening, and **multiple application attempts**.
- [ ] Preserve per-attempt applicant email and phone number **if evidenced**; never fabricate missing contact fields.
- [ ] Import user-selected .eml forward(s) from the **primary personal mailbox without OAuth**.
- [ ] Deduplicate replayed and forwarded observations without merging distinct submissions.
- [ ] Evidence-linked timeline and reversible correction/review queue for ambiguous matches.
- [ ] Independent stage/outcome, listing availability (unknown unless checked), and monitoring coverage.
- [ ] Show 60-day recent view **plus** older actionable applications; never expire by age alone.
- [ ] Safe logs, access counts, token encryption, per-user authorization and deletion controls.

## Explicitly out of scope

- Browser extension/autofill/automatic applications; sending follow-up emails
- Reading personal primary Gmail by default
- AI sending entire messages to third-party services
- Auto-checking every external ATS portal or guaranteeing vacancy availability
- Determining whether a second contact identity bypassed employer duplicate detection
- Candidate ranking, salary negotiation, calendar integration, recruiter CRM, mobile apps
- Push notifications through Pub/Sub, Kubernetes, Kafka, multi-region deployment

## Required UI surfaces

1. **Connections:** account, last healthy sync, initial scan coverage, disconnect.
2. **Inbox of applications:** employer, title, attempts count, latest accepted stage/outcome, and monitoring label.
3. **Opening detail:** independent attempts by applicant email/phone (masked), submitted date, per-attempt timeline and evidence provenance.
4. **Needs review:** unknown job/attempt match, conflicting events, forwarded email with ambiguous origin.
5. **Import:** .eml forwarding instructions and import results/errors.
6. **Activity explanation:** "No response observed in connected sources since …", never simply "Rejected" because 60 days elapsed.

## Acceptance scenarios

| Scenario | Expected result |
| --- | --- |
| Same job, two accounts, distinct confirmations | One opening, two attempts |
| Same job, same email, two genuinely separate submissions | Two attempts only when independent submission evidence exists |
| Different job requisitions, same title | Two distinct openings |
| Same confirmation seen twice or forwarded | One submission, deduplicated observations |
| One attempt rejected, another interviewed | Independent outcomes |
| Rejection mentions only employer | Remains unresolved if multiple candidate attempts |
| Connected mail arrives for 4-month-old attempt | Old attempt updated; no 60-day cutoff |
| Old primary-Gmail attempt with no forward | Retained as manually monitored; "no response" not asserted |
| OTP/login message | No application event; body not deliberately fetched when header signals are clear |
| History cursor 404 | Gap flagged, resync, no lost durable work |
| Unauthorized user guesses artifact ID | Deny access; no cross-tenant data exposure |
| Original forwarded .eml has different account identity | Preserve original recipient separately from forward envelope |

## Quality gates

- Build an anonymized, consented or synthetic **ground-truth corpus** spanning several ATS styles and different identities before tuning extraction.
- Measure **application detection precision/recall**, **opening/attempt matching precision**, **terminal-event precision**, and **manual-review rate** separately.
- Initially fail closed on any low-confidence terminal outcome or ambiguous attempt. Favor manual review over a wrong rejection/offer.
- Test deterministic idempotency and backfill-to-incremental continuity.
- Treat *zero known false terminal assignments on evaluation fixtures* as a release gate, not a statistical guarantee; grow the dataset before broader claims.
- Do not connect real personal mailboxes until the security checklist in [privacy-security.md](privacy-security.md) is implemented.

## Definition of done

The owner can connect two test/dedicated mailboxes, reconstruct recent sample applications, import selectively forwarded historical messages, view multiple attempt histories per opening, receive later updates, and understand **exactly which applications are not continuously monitored**. No raw message bodies need to be retained.
