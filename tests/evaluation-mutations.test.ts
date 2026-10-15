import assert from "node:assert/strict";
import { it } from "node:test";
import { CORPUS } from "./corpus/emails.ts";
import {
  scoreCorpus,
  summarize,
  verdict,
  type CaseResult,
} from "./corpus/score.ts";
import { extractCompanyAndTitle } from "../src/ingestion/fields.ts";
import { extractSignal, isHiringSignal } from "../src/ingestion/extract.ts";
import { parseEml } from "../src/ingestion/eml.ts";
import { messageSensitivity } from "../src/ingestion/privacy.ts";
import { buildEml } from "./helpers/eml.ts";

it("corpus results survive CRLF, whitespace, repeated quoted history, and ordinary footer additions", async () => {
  const mutations = CORPUS.map((email) => ({
    ...email,
    text:
      (email.text ?? "").replace(/\n/g, "\r\n") +
      "\r\n> We are delighted to offer you the Wrong Engineer role at Wrong Company.\r\n".repeat(
        4,
      ) +
      "\r\nPrivacy Policy\r\nUnsubscribe",
  }));
  const before = await scoreCorpus(CORPUS),
    after = await scoreCorpus(mutations);
  for (let i = 0; i < before.length; i++)
    assert.deepEqual(after[i]!.actual, before[i]!.actual, before[i]!.email.id);
});

it("metrics distinguish correct absences from recovered positive fields", () => {
  const template = CORPUS[0]!;
  const row = (expected: string | null, actual: string | null) =>
    ({
      email: { ...template, expect: { ...template.expect, title: expected } },
      expect: { ...template.expect, title: expected },
      actual: { kind: null, company: null, title: actual },
      verdicts: {
        kind: "correct",
        company: "correct",
        title: verdict(expected, actual),
      },
    }) as CaseResult;
  const summary = summarize([
    row(null, null),
    row(null, null),
    row("Engineer", "Engineer"),
    row("Analyst", null),
  ]).title;
  assert.equal(summary.accuracy, 0.75);
  assert.equal(summary.precision, 1);
  assert.equal(summary.recall, 0.5);
  assert.equal(summary.coverage, 0.25);
  assert.equal(summarize([]).title.precision, null);
});

it("excessive distinct candidate evidence abstains with bounded diagnostics", () => {
  const result = extractCompanyAndTitle({
    fromName: "Careers",
    fromAddress: "careers@acme.example",
    subject: "Application received",
    body: Array.from(
      { length: 500 },
      (_, i) => `Job Title: Engineer ${i}`,
    ).join("\n"),
  });
  assert.equal(result.title, null);
  assert.equal(result.decisions.title.state, "AMBIGUOUS");
  assert.equal(result.decisions.title.candidates.length, 8);
});

// Real hiring mail is full of tokenized links (portal status, assessment, click tracking, signed
// logos). The corpus is written without them, so add them to every message: extraction must not
// change, and no positive message may be dropped by the privacy screen.
it("corpus results and privacy decisions survive the links real hiring mail carries", async () => {
  const links = [
    "View your application: https://app.greenhouse.io/applications/status?token=opaque-access",
    "Start: https://www.hackerrank.com/tests/abc123/login?token=Zx81Qp",
    "https://email.example.net/c/AbCdEf0123456789?sig=zzz",
  ].join("\n");
  const logo =
    '<img src="https://cdn.example.com/logo.png?Signature=abc&Expires=1">';
  const mutations = CORPUS.map((email) => ({
    ...email,
    text: `${email.text ?? ""}\n\n${links}`,
    ...(email.html !== undefined ? { html: `${email.html}${logo}` } : {}),
  }));
  const before = await scoreCorpus(CORPUS),
    after = await scoreCorpus(mutations);
  for (let i = 0; i < before.length; i++)
    assert.deepEqual(after[i]!.actual, before[i]!.actual, before[i]!.email.id);
  for (const email of mutations.filter((e) => e.expect.kind !== null)) {
    const raw = buildEml({
      from: email.from,
      to: "robin.example@example.com",
      subject: email.subject,
      date: "Mon, 12 Oct 2026 09:30:00 +0000",
      messageId: `<${email.id}@links.example>`,
      text: email.text,
      ...(email.html !== undefined ? { html: email.html } : {}),
    });
    const [original] = await parseEml(new TextEncoder().encode(raw));
    const level = messageSensitivity(original!.message);
    assert.notEqual(level, "CREDENTIAL", email.id);
    assert.ok(
      level === "NONE" || isHiringSignal(extractSignal(original!.message)),
      `${email.id}: dropped as sensitive`,
    );
  }
});
