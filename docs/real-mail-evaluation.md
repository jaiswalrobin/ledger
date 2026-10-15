# Evaluating on real mail

The synthetic corpus (`npm run eval:parser`) shows the extractor handles the cases we wrote. It
cannot show how Ledger does on mail nobody wrote for it. `npm run eval:real` measures that, on your
own messages, without anything leaving your machine.

## 1. Collect emails

In Gmail, open a message, choose **⋮ → Download message**, and save the `.eml` file into
`eval/real/` at the repository root. That folder is git-ignored; the tool refuses to write labels
anywhere git would track them.

Take a cross-section, not just mail you expect to work:

- confirmations, assessments, interview invitations and calendar invites, rejections, offers;
- several employers and hiring platforms (Greenhouse, Lever, Workday, LinkedIn, direct employer
  mail), several emails per application where you have them;
- non-hiring mail that looks close: job alerts, newsletters from job boards, recruiter outreach.

Downloaded messages keep Gmail's `Authentication-Results` header, so the evaluation sees the
same sender verdict as Gmail sync.

## 2. Label

```sh
npm run eval:real -- label
```

This adds an entry to `eval/real/labels.json` for each new file, pre-filled from the extractor:

```json
"acme-rejection.eml": {
  "verified": false,
  "kind": "REJECTION_RECEIVED",
  "company": "Acme",
  "title": "Backend Engineer",
  "note": ""
}
```

Open each email and correct the fields against the message itself, not against the guess:

- `kind`: one of `CONFIRMATION_RECEIVED`, `ASSESSMENT_INVITED`, `INTERVIEW_INVITED`,
  `INTERVIEW_SCHEDULED`, `REJECTION_RECEIVED`, `OFFER_RECEIVED`, or `null` for mail that is not
  about one of your applications;
- `company` and `title`: as the email states them, or `null` when it does not say.

Then set `"verified": true`. Only verified labels are scored. Running `label` again adds new files
and never changes existing entries.

## 3. Score

```sh
npm run eval:real
```

The report has two parts.

**Extraction**: the same accuracy, precision, recall and coverage table as `eval:parser`, the
rules that backed wrong values or lost the right one, and each field the extractor got wrong.

**Pipeline**: every email, labelled or not, runs through the real ingestion pipeline on an
in-memory database, in Date order, as if Gmail sync had fetched it. Each labelled email's final
state is then compared with its label:

| Result | Meaning |
| --- | --- |
| applied correctly | the right event, on the job the label names |
| **APPLIED WRONGLY** | any automatic change that contradicts the label; must be 0 |
| waiting in review | hiring mail left for a person |
| lost hiring mail | hiring mail dismissed, or skipped as sensitive |
| review noise | non-hiring mail sent to review |
| ignored | non-hiring mail, correctly left alone |

Review reasons are counted, and every wrong, lost or failed email is listed by file name. The
command exits non-zero when anything was applied wrongly.

## What it does not cover

- **Discovery.** Gmail sync only fetches messages its queries find; here every file is processed.
  `tests/corpus-ingestion.test.ts` models discovery on the synthetic corpus.
- **Threads.** A download carries reply headers but no Gmail thread id, so linking by thread is
  not exercised; linking by `In-Reply-To`/`References` is.
- **Forwarded copies** attached inside a message are skipped.
- **Independence.** Once you change a rule because of an email, that email is no longer a fair
  test of it. Keep some labelled mail aside that you never look at while changing rules, and
  report results on that set.

## Privacy

Emails and labels stay in `eval/real/`. The report prints file names, labels and extracted fields
only, never message text. Labels hold the same safe fields Ledger itself stores.
