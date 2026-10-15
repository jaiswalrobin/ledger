import assert from "node:assert/strict";
import { it } from "node:test";
import {
  extractCompanyAndTitle,
  type FieldInput,
} from "../src/ingestion/fields.ts";

const input: FieldInput = {
  subject: "Application received: Acme - Backend Engineer",
  body: "We received your application.",
  fromName: "Recruiting",
  fromAddress: "careers@careers.acme.co.uk",
};

it("public suffix boundaries find the registrable employer behind country-code suffixes", () => {
  assert.equal(extractCompanyAndTitle(input).company, "Acme");
  const result = extractCompanyAndTitle({
    ...input,
    fromAddress: "careers@careers.acme.k12.ca.us",
  });
  assert.equal(result.company, "Acme");
});

it("private suffixes preserve the tenant's boundary instead of corroborating the hosting provider", () => {
  const result = extractCompanyAndTitle({
    ...input,
    fromAddress: "careers@acme.github.io",
  });
  assert.equal(result.company, "Acme");
  assert.equal(
    extractCompanyAndTitle({
      ...input,
      subject: "Application received: Github - Backend Engineer",
      fromAddress: "careers@acme.github.io",
    }).company,
    null,
  );
});

it("domain prefixes never corroborate an unrelated employer name", () => {
  const result = extractCompanyAndTitle({
    ...input,
    subject: "Application received: Acmeology - Backend Engineer",
  });
  assert.equal(result.company, null);
  assert.equal(result.title, null);
});

it("explicit domain aliases corroborate content without generating absent names", () => {
  const companyAliases = [{ company: "Acme Labs", domain: "acme.co.uk" }];
  const result = extractCompanyAndTitle({
    ...input,
    subject: "Application received: Acme Labs - Backend Engineer",
    companyAliases,
  });
  assert.equal(result.company, "Acme Labs");
  assert.equal(
    extractCompanyAndTitle({
      ...input,
      subject: "Application received",
      companyAliases,
    }).company,
    null,
  );
});

it("free-mail addresses provide no employer authority", () => {
  assert.equal(
    extractCompanyAndTitle({ ...input, fromAddress: "acme@gmail.com" }).company,
    null,
  );
});
