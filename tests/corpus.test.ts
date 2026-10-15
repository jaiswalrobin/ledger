import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreCorpus, summarize } from "./corpus/score.ts";
import { CORPUS } from "./corpus/emails.ts";
import { HOLDOUT } from "./corpus/holdout.ts";

// Every labelled email must keep extracting correctly; a regression names the email and field.
describe("extractor corpus", async () => {
  const results = await scoreCorpus(CORPUS);
  for (const r of results)
    it(`${r.email.id}: ${r.email.note}`, () => {
      assert.deepEqual(
        r.actual,
        { kind: r.email.expect.kind, company: r.email.expect.company, title: r.email.expect.title },
      );
    });
});

// Held-out emails were never used for tuning. They may have misses, but never a wrong or invented
// value (a wrong company or title creates a separate job opening), and accuracy must not fall.
describe("extractor held-out set", async () => {
  const summary = summarize(await scoreCorpus(HOLDOUT));
  it("never produces a wrong or invented value", () => {
    for (const [field, s] of Object.entries(summary))
      assert.equal(s.wrong + s.spurious, 0, `${field}: ${s.wrong} wrong, ${s.spurious} spurious`);
  });
  it("keeps accuracy at or above the recorded floor", () => {
    assert.ok(summary.kind.accuracy >= 0.9, `kind ${summary.kind.accuracy}`);
    assert.ok(summary.company.accuracy >= 0.9, `company ${summary.company.accuracy}`);
    assert.ok(summary.title.accuracy >= 0.7, `title ${summary.title.accuracy}`);
  });
});
