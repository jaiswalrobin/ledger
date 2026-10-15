import assert from "node:assert/strict";
import { it } from "node:test";
import { previewExtraction } from "../src/ingestion/preview.ts";
import { extractSignal } from "../src/ingestion/extract.ts";
import type { ParsedMessage } from "../src/ingestion/source.ts";

const message: ParsedMessage = {
  fromName: "Acme Careers",
  fromAddress: "careers@acme.example",
  to: [],
  subject: "Application received",
  date: "2026-10-12T09:30:00Z",
  messageId: "<preview@example.com>",
  text: "We received your application.\nCompany: Acme\nJob Title: Backend Engineer\nFor the Frontend Engineer role at Globex.",
};

it("a version preview exposes changes and review requirements without modifying its input", () => {
  const snapshot = structuredClone(message);
  const result = previewExtraction(message, {
    version: "old",
    extract(input) {
      const signal = extractSignal(input);
      return {
        ...signal,
        confidence: "HIGH",
        fields: {
          ...signal.fields,
          company: "Acme",
          title: "Frontend Engineer",
        },
      };
    },
  });
  assert.equal(result.status, "PREVIEW");
  if (result.status !== "PREVIEW") return;
  assert.equal(result.requiresReview, true);
  assert.deepEqual(
    result.changes.map((change) => change.field),
    ["company", "title"],
  );
  assert.deepEqual(message, snapshot);
  assert.ok(!JSON.stringify(result).includes("We received your application"));
});

it("sensitive previews run neither extractor and expose no credential content", () => {
  let calls = 0;
  const result = previewExtraction(
    { ...message, text: "Your verification code is 123456" },
    {
      version: "old",
      extract(input) {
        calls++;
        return extractSignal(input);
      },
    },
  );
  assert.deepEqual(result, { status: "SKIPPED_SENSITIVE" });
  assert.equal(calls, 0);
});
