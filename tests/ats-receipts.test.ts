import assert from "node:assert/strict";
import { it } from "node:test";
import { atsReceiptHints } from "../src/ingestion/ats-receipts.ts";
import { extractSignal } from "../src/ingestion/extract.ts";
import { parseEml } from "../src/ingestion/eml.ts";
import { buildEml, type EmlSpec } from "./helpers/eml.ts";
import { ATS_RECEIPT_CORPUS } from "./corpus/ats-receipts.ts";

const base: EmlSpec = {
  from: '"Careers" <talent@greenhouse-mail.io>',
  to: "candidate@example.org",
  subject: "Thank you for applying to Example Labs!",
  text: "We received your application.",
};
async function extract(over: Partial<EmlSpec> = {}) {
  const [p] = await parseEml(Buffer.from(buildEml({ ...base, ...over })));
  return extractSignal(p!.message);
}
it("recovers explicit ATS receipt fields in every new development example", async () => {
  for (const sample of ATS_RECEIPT_CORPUS) {
    const s = await extract(sample);
    assert.equal(s.kind, sample.expect.kind, sample.id);
    assert.equal(s.fields.company, sample.expect.company, sample.id);
    assert.equal(s.fields.title, sample.expect.title, sample.id);
    assert.equal(s.reasons.includes("conflicting-fields"), false, sample.id);
  }
});
it("never invents a role when a receipt only confirms the employer", async () => {
  const s = await extract();
  assert.equal(s.fields.company, "Example Labs");
  assert.equal(s.fields.title, null);
});
it("does not use a template from a lookalike sender or a display-name claim", async () => {
  for (const from of [
    '"Greenhouse" <talent@greenhouse-mail.io.evil.example>',
    '"Greenhouse" <talent@unknown.example>',
  ]) {
    const s = await extract({
      from,
      text: "We received your application.\nPosition applied for: Staff Engineer",
    });
    assert.equal(s.fields.title, null);
  }
});
it("a public posting identifier can select a recipe for a custom employer sender", async () => {
  const s = await extract({
    from: '"Careers" <talent@example.org>',
    text: "We received your application.\nPosition applied for: Staff Engineer\nhttps://boards.greenhouse.io/example/jobs/12345",
  });
  assert.equal(s.fields.title, "Staff Engineer");
});
it("never treats a suggested job link or footer as the application role", async () => {
  const s = await extract({
    html: '<p>We received your application.</p><footer>Other openings: <a href="https://boards.greenhouse.io/example/jobs/12345">Staff Engineer</a></footer>',
    text: "",
  });
  assert.equal(s.fields.title, null);
});
it("does not read quoted history or a trailing signature as receipt labels", async () => {
  for (const html of [
    "<p>We received your application.</p><blockquote>Position applied for: Staff Engineer</blockquote>",
    "<p>We received your application.</p><p>Best regards,</p><p>Position applied for: Staff Engineer</p>",
  ])
    assert.equal((await extract({ text: "", html })).fields.title, null);
});
it("a missing split field does not consume another field's label or value", async () => {
  for (const next of [
    "Company: Other Labs",
    "Location: Berlin",
    "Candidate ID: 123456",
    "Job Title: Staff Engineer",
  ]) {
    const s = atsReceiptHints({
      fromAddress: "talent@greenhouse-mail.io",
      confirmed: true,
      jobKey: null,
      body: `Position applied for\n${next}`,
      isPublicJobUrl: () => false,
    });
    assert.equal(s.titles.length, 0);
  }
});
it("private portal URLs never become labelled job-title evidence", async () => {
  const s = await extract({
    text: "We received your application.\nJob Title: Staff Engineer (https://app.greenhouse.io/candidate/secret)",
  });
  assert.equal(s.fields.title, null);
});
it("a requisition or posting identifier is not a job title", async () => {
  for (const value of [
    "JR-123456",
    "123456",
    "6f1c1c2e-aaaa-4bbb-8ccc-0123456789ab",
  ]) {
    const s = await extract({
      text: `We received your application.\nPosition applied for: ${value}`,
    });
    assert.equal(s.fields.title, null);
  }
});
it("missing values and navigation buttons do not become application titles", async () => {
  for (const value of [
    "Not provided",
    "Unknown",
    "TBD",
    "Learn more",
    "View posting",
    "See job details",
    "Apply now",
  ]) {
    const s = await extract({
      text: `We received your application.\nPosition applied for\n${value}`,
    });
    assert.equal(s.fields.title, null, value);
  }
});
it("conflicting explicit title assertions still require review", async () => {
  const s = await extract({
    text: "We received your application.\nPosition applied for: Staff Engineer\nJob Title: Data Engineer",
  });
  assert.equal(s.fields.title, null);
  assert.equal(s.fields.fieldDecisions!.title.state, "AMBIGUOUS");
  assert.ok(s.reasons.includes("conflicting-fields"));
});
it("the same labelled assertion keeps one support source even if repeated", async () => {
  const once = await extract({
    text: "We received your application.\nPosition applied for: Staff Engineer",
  });
  const twice = await extract({
    text: "We received your application.\nPosition applied for: Staff Engineer\nPosition applied for: Staff Engineer",
  });
  assert.deepEqual(
    once.fields.fieldDecisions!.title,
    twice.fields.fieldDecisions!.title,
  );
});
it("inspection limits are surfaced as uncertainty rather than silently dropping the tail", async () => {
  const s = await extract({
    text:
      "We received your application.\n" +
      "Position applied for: Staff Engineer\n".repeat(34),
  });
  assert.ok(s.reasons.includes("conflicting-fields"));
});
