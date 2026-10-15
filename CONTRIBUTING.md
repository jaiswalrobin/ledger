# Contributing

Ledger turns a person's job-application email into a record of their applications. A wrong
automatic change (a rejection on the wrong job, a duplicate opening) is worse than no change, so
most of these rules exist to keep changes reviewable and measured.

## Working on a change

- **One change, one branch, one author.** Start every change from an up-to-date `main`. Never
  have two people or two agents push to the same branch: their commits interleave, each reviews
  code the other has since changed, and neither can vouch for the whole.
- **Small pull requests.** One concern per pull request. Keep behaviour changes, refactors,
  formatting and migrations in separate commits, and preferably in separate pull requests.
  A reviewer should be able to read the non-test diff in one sitting (a few hundred lines).
- **Explain why.** Commit messages and pull request descriptions say what was wrong and why the
  change is right, not only what changed.

## Before you push

```sh
npm run check        # formatting, types, unit tests (seconds)
npm run check:full   # everything CI runs: also migrations, PostgreSQL tests, build, browser, smoke
```

`check:full` needs a disposable local PostgreSQL in `DATABASE_URL` (`scripts/dev-db.sh` starts
one; see [docs/deployment.md](docs/deployment.md)). Run it for anything touching migrations,
SQL, the pipeline, or the app. Push only when it passes; a red CI run costs everyone a cycle.

Formatting is Prettier's default style: run `npm run format`. `npm test` fails on unformatted
files.

## Where rules live

- **Decisions** (what is skipped, dismissed, sent to review, or applied automatically) live in
  [`src/domain/policy.ts`](src/domain/policy.ts), as pure functions with exhaustive tests in
  `tests/policy.test.ts`. The pipeline gathers facts and asks the policy; it does not decide.
  A test fails if decision logic reappears in `pipeline.ts`.
- **Extraction rules** for company and title each have an id in `FIELD_RULES`
  (`src/ingestion/fields.ts`). A new rule needs a corpus email or a named example in
  `tests/rule-coverage.test.ts`, or the tests fail.
- **Migrations** are numbered files in `migrations/`. Never edit one that has been applied
  (checksums are enforced); add a new one and update the list in `tests/db.test.ts`.

## Measuring parser changes

- `npm run eval:parser` and `npm run eval:parser -- holdout` score the synthetic sets, with a
  per-rule report. Do not tune rules to the holdout set; once an email has guided a fix it
  belongs in the development corpus.
- `npm run eval:real` scores your own Gmail downloads locally, through the real pipeline. See
  [docs/real-mail-evaluation.md](docs/real-mail-evaluation.md). Real mail never goes in the
  repository.

## Privacy

Never store, log or print message content: bodies, links, addresses or tokens. Server code has
no `console` calls (a test enforces it). Test data is synthetic, using example domains.
