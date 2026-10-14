import assert from "node:assert/strict";
import { it } from "node:test";
import { parseEml } from "../src/ingestion/eml.ts";
import { extractSignal } from "../src/ingestion/extract.ts";
import { buildEml } from "./helpers/eml.ts";
import { messageRegions } from "../src/ingestion/regions.ts";

async function extract(text: string, html?: string, subject = "Application received") {
  const [original] = await parseEml(new TextEncoder().encode(buildEml({
    from: "Acme Careers <careers@acme.example>", to: "applicant@example.com", subject, text,
    ...(html === undefined ? {} : { html }),
  })));
  return extractSignal(original!.message);
}

it("plain-text history cannot change current fields, application id, or declared applicant", async () => {
  const current = "We received your application for the Backend Engineer role at Acme.";
  const history = "\n\nOn Monday, Recruiter wrote:\n> We received your application for the Frontend Engineer role at Globex.\n> Application ID: OLD-12345\n> Submitted email: other@example.com";
  const signal = await extract(current + history.repeat(10));
  assert.equal(signal.fields.company, "Acme");
  assert.equal(signal.fields.title, "Backend Engineer");
  assert.equal(signal.fields.externalApplicationId, null);
  assert.equal(signal.fields.applicantEmail, null);
});

it("HTML blockquotes are isolated while authored text after a quote remains available", async () => {
  const signal = await extract("", "<blockquote><p>We received your application for the Frontend Engineer role at Globex.</p></blockquote><p>We received your application for the Backend Engineer role at Acme.</p>");
  assert.equal(signal.fields.company, "Acme");
  assert.equal(signal.fields.title, "Backend Engineer");
});

it("a reply's old subject and quoted receipt cannot create a new confirmation", async () => {
  const signal = await extract("Thanks!\n\n> We received your application for the Backend Engineer role at Acme.", undefined, "Re: Application received: Backend Engineer at Acme");
  assert.equal(signal.kind, null);
  assert.ok(signal.reasons.includes("quoted-history-only"));
});

it("generic footer adjacency does not assert a job title", async () => {
  const signal = await extract("We received your application.\nCompany: Acme\nAcme\nPrivacy Policy");
  assert.equal(signal.fields.title, null);
});

it("signatures remain employer evidence, not event assertions", () => {
  assert.deepEqual(messageRegions("Hello\n\nBest,\nAcme Recruiting\nInterview invitation"), {
    current: "Hello\n", signature: "Best,\nAcme Recruiting\nInterview invitation", hasQuotedHistory: false,
  });
});
