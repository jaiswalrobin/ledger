# Understanding and recovering Gmail imports

Connections reports sync execution separately from email recognition. **Healthy**
and **Backfill complete** mean discovered work finished, not that every application
in the mailbox was recognized. The initial search covers the last 60 days. Future
mail is discovered through Gmail history; silence is never treated as rejection.

Email totals are not application totals. Several confirmations and updates can
belong to one opening, and separate submissions remain separate attempts. Emails
that identify an employer but not a role stay in review. A role absent from the
email must be supplied by the owner; Ledger does not invent it.

## Previewing a parser improvement

For an original `.eml` already available locally, run:

```sh
npm run preview:parser -- original.eml --baseline-ref COMMIT
```

The output compares extractor proposals, not database application outcomes. It uses current MIME
decoding and installed dependencies for both versions, prints no message bodies, and changes no
accepted history. Sensitive content is excluded before either extractor runs. The baseline commit
must already exist locally. Use the preview to identify records needing an owner-reviewed correction;
rechecking continues to preserve existing decisions.

## After deploying a parser improvement

1. Merge the reviewed changes and wait for Ledger CI/CD on `main` to succeed.
   This release applies `0008_mailbox_recheck.sql` before promotion. Google settings
   and `DEMO_MODE=false` must already be configured for a private production app.
2. Open **Connections → Recheck last 60 days**. This starts a fresh, bounded search
   and retries previously skipped candidates using the current parser. It does
   not delete history or change existing timeline events or review decisions.
   Open review items are also preserved; resolve those through Needs review.
3. If progress is partial, use **Sync now** to resume. Page positions, queued work,
   and recovery intent survive interruptions and transient provider errors.
   **Retry failed work** remains available for exhausted retries.
4. Inspect the processing totals and **See recent excluded emails**. Up to 20
   exclusions link back to the original in the connected Gmail account. No email
   bodies or credential-bearing subjects are stored in this diagnostic list.
5. Verify the IBM confirmation against Gmail: employer IBM, actual role, and
   September 30 confirmation date. The job requisition scopes the opening;
   Candidate ID identifies a person and never identifies an application attempt.
   Updates without a submission-specific identity require review.

Rechecks are owner-scoped, rate-limited, refuse active workers, and use a generation
to avoid requeuing a message twice across overlapping queries. Existing accepted,
rejected, assigned, or dismissed evidence is protected by transaction checks.
An old source whose provider payload changed is not silently overwritten.

Privacy checks still exclude OTPs, sign-in/reset/verification links, bearer JWTs,
and unknown token-bearing access links. Clearly identified tracking/unsubscribe
links may accompany a legitimate recruiting message, but those links and their
tokens are never stored. Parsing limits and damaged attachments are reported;
valid sibling originals can be imported with an explicit partial-processing result.
Missing dates remain unknown rather than being inferred from mail-routing headers.

For older history, import selected original `.eml` files. Automated tests use
synthetic emails and fake Gmail providers; a successful local test run is not
proof that every live employer template will be recognized. Check real results
after deployment and use the diagnostic exclusions to identify remaining gaps.
