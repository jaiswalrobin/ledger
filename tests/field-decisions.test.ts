import assert from "node:assert/strict";
import { it } from "node:test";
import { extractSignal } from "../src/ingestion/extract.ts";
import { extractCompanyAndTitle } from "../src/ingestion/fields.ts";

const fields = (body: string, subject = "Application received") =>
  extractCompanyAndTitle({
    body,
    subject,
    fromName: "Acme Careers",
    fromAddress: "careers@acme.example",
  });

it("credible conflicting pairs abstain instead of synthesizing an employer/title pair", () => {
  const result = fields(
    "We received your application.\nCompany: Acme\nJob Title: Backend Engineer\nFor the Frontend Engineer role at Globex.",
  );
  assert.equal(result.company, null);
  assert.equal(result.title, null);
  assert.equal(result.decisions.company.state, "AMBIGUOUS");
  assert.equal(result.decisions.title.state, "AMBIGUOUS");
});

it("repeating the same body evidence cannot outweigh an explicit field", () => {
  const prefix =
    "We received your application.\nCompany: Acme\nJob Title: Backend Engineer\n";
  const once = fields(prefix + "Application to Globex.");
  const repeated = fields(prefix + "Application to Globex.\n".repeat(100));
  assert.deepEqual(repeated.decisions, once.decisions);
  assert.equal(repeated.decisions.company.state, "AMBIGUOUS");
});

it("hard wrapping does not change a conflict decision or inflate support", () => {
  const subject = "Application received: Backend Engineer";
  const a = fields(
    "We received your application. Your application for Frontend Engineer.",
    subject,
  );
  const b = fields(
    "We received your application.\nYour application for Frontend Engineer.",
    subject,
  );
  assert.deepEqual(a, b);
  assert.equal(a.title, null);
});

it("MIME merging cannot upgrade a field conflict to high confidence", () => {
  const signal = extractSignal({
    subject: "Application received",
    fromName: "Acme Careers",
    fromAddress: "careers@acme.example",
    date: "2026-10-12T09:30:00Z",
    messageId: "<conflict@example.com>",
    to: [],
    text: "Company: Acme\nJob Title: Backend Engineer\nFor the Frontend Engineer role at Globex.",
    alternativeTexts: ["We received your application."],
  });
  assert.equal(signal.confidence, "LOW");
  assert.ok(signal.reasons.includes("conflicting-fields"));
  assert.equal(signal.fields.fieldDecisions?.title.state, "AMBIGUOUS");
});

it("MIME ambiguity keeps the field null in both representation orders", () => {
  const ambiguous =
    "We received your application.\nCompany: Acme\nJob Title: Backend Engineer\nFor the Frontend Engineer role at Acme.";
  const supported =
    "We received your application.\nCompany: Acme\nJob Title: Frontend Engineer";
  for (const [text, alternative] of [
    [ambiguous, supported],
    [supported, ambiguous],
  ]) {
    const signal = extractSignal({
      subject: "Application received",
      fromName: "Acme Careers",
      fromAddress: "careers@acme.example",
      date: null,
      messageId: null,
      to: [],
      text: text!,
      alternativeTexts: [alternative!],
    });
    assert.equal(signal.fields.title, null);
    assert.equal(signal.fields.fieldDecisions?.title.state, "AMBIGUOUS");
    assert.equal(signal.fields.fieldDecisions?.title.value, null);
    assert.equal(signal.confidence, "LOW");
  }
});

it("conflicting supported MIME values become ambiguous while a stub can inherit real fields", () => {
  const message = {
    subject: "Application received",
    fromName: "Acme Careers",
    fromAddress: "careers@acme.example",
    date: null,
    messageId: null,
    to: [],
  };
  const real =
    "We received your application.\nCompany: Acme\nJob Title: Backend Engineer";
  const conflict = extractSignal({
    ...message,
    text: real,
    alternativeTexts: [real.replace("Backend", "Frontend")],
  });
  assert.equal(conflict.fields.title, null);
  assert.equal(conflict.fields.fieldDecisions?.title.state, "AMBIGUOUS");
  assert.ok(conflict.reasons.includes("conflicting-alternatives"));
  const stub = extractSignal({
    ...message,
    text: "View this email in your browser.",
    alternativeTexts: [real, real],
  });
  const single = extractSignal({ ...message, text: real });
  assert.equal(stub.fields.title, "Backend Engineer");
  assert.deepEqual(stub.fields.fieldDecisions, single.fields.fieldDecisions);
});

it("subject pairs use sender evidence collected first and the same cleaning on lookup", () => {
  for (const name of ["Acme", "Acme Careers"]) {
    const result = extractCompanyAndTitle({
      subject: `Application received: ${name} - Backend Engineer`,
      body: "We received your application.",
      fromName: "Acme",
      fromAddress: "no-reply@greenhouse.io",
    });
    assert.equal(result.company, "Acme");
    assert.equal(result.title, "Backend Engineer");
  }
});

it("an agency affiliation corroborates identity without vetoing explicit job evidence", () => {
  const result = extractCompanyAndTitle({
    subject: "Application received: Backend Engineer at Stripe",
    body: "Company: Stripe\nJob Title: Backend Engineer\nI am a recruiter at TalentHub working on behalf of Stripe.",
    fromName: "Stripe",
    fromAddress: "no-reply@greenhouse.io",
  });
  assert.equal(result.company, "Stripe");
  assert.equal(result.title, "Backend Engineer");
});

it("a role bound to an unrecognized employer cannot inherit an unrelated sender's employer", () => {
  const result = extractCompanyAndTitle({
    subject: "Application received",
    body: "We received your application for the Software Engineer role at 123456.",
    fromName: "Acme",
    fromAddress: "no-reply@greenhouse.io",
  });
  assert.equal(result.title, null);
  assert.equal(result.decisions.title.state, "AMBIGUOUS");
});

it("US Bank is a named employer rather than a prose pronoun", () => {
  const result = extractCompanyAndTitle({
    subject: "Application received",
    body: "We received your application for the Software Engineer role at US Bank in Minneapolis.",
    fromName: "Acme",
    fromAddress: "no-reply@greenhouse.io",
  });
  assert.equal(result.company, "US Bank");
  assert.equal(result.title, "Software Engineer");
});

it("spelling variants of one employer merge instead of conflicting", () => {
  const variants = fields(
    "We received your application for the Data Engineer role at Acme.",
    "Thank you for applying to Acme Inc",
  );
  assert.equal(variants.decisions.company.state, "SUPPORTED");
  assert.equal(variants.company, "Acme");
  const caps = fields(
    "Company: ACME\nWe received your application for the Data Engineer role at Acme.",
  );
  assert.equal(caps.company, "Acme");
});

it("a shared prefix is not the same employer", () => {
  const result = fields(
    "We received your application.\nCompany: Acme\nFor the Frontend Engineer role at Acme Robotics.",
  );
  assert.equal(result.decisions.company.state, "AMBIGUOUS");
});

it("independent mechanisms corroborate; repeats and wrapped copies of one do not", () => {
  const label = fields(
    "We received your application.\nCompany: Acme\nJob Title: Backend Engineer",
  );
  const both = fields(
    "We received your application.\nCompany: Acme\nJob Title: Backend Engineer\nThank you for applying for the Backend Engineer position at Acme.",
  );
  const repeated = fields(
    "We received your application.\nCompany: Acme\nJob Title: Backend Engineer\n" +
      "Thank you for applying for the Backend Engineer position at Acme.\n".repeat(
        20,
      ),
  );
  const score = (r: typeof label) => r.decisions.title.candidates[0]!.score;
  assert.ok(score(both) > score(label));
  assert.deepEqual(both.decisions.title.candidates[0]!.sources, [
    "body:label",
    "body:sentence",
  ]);
  assert.deepEqual(repeated.decisions, both.decisions);
});

it("a role 'at our company' or 'at our Berlin office' stays with the sender's employer", () => {
  for (const place of [
    "our company",
    "our Berlin office",
    "the company",
    "our engineering team",
  ]) {
    const result = extractCompanyAndTitle({
      subject: "Thank you for applying to Acme",
      body: `Thank you for applying for the Data Engineer role at ${place}. We have received your application.`,
      fromName: "Acme Careers",
      fromAddress: "careers@acme.example",
    });
    assert.equal(result.company, "Acme", place);
    assert.equal(result.title, "Data Engineer", place);
  }
});

it("a product-style domain corroborates its organisation, never another one", async () => {
  const { employerDomain, organisationNames } =
    await import("../src/ingestion/fields.ts");
  assert.deepEqual(organisationNames("getweave"), ["getweave", "weave"]);
  assert.deepEqual(organisationNames("acmehq"), ["acmehq", "acme"]);
  assert.deepEqual(organisationNames("google"), ["google"]);
  assert.equal(employerDomain("getweave.com", "Weave"), "getweave.com");
  assert.equal(employerDomain("joinacme.io", "Acme"), "joinacme.io");
  assert.equal(employerDomain("getweave.com", "Globex"), null);
  // Too short to be a name once the affix is gone.
  assert.equal(employerDomain("getit.com", "It"), null);
});
