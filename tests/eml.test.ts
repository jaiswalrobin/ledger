import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EML_LIMITS,
  EmlError,
  parseEml,
  redactSubject,
} from "../src/ingestion/eml.ts";
import { buildEml, forwardAsAttachment } from "./helpers/eml.ts";
import {
  APPLICANT_A,
  greenhouseConfirmation,
  interviewInvite,
} from "./helpers/fixtures.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("parseEml: direct original", () => {
  it("parses headers and plain text, keeping original date and sender", async () => {
    const [m] = await parseEml(bytes(buildEml(greenhouseConfirmation())));
    assert.ok(m);
    assert.equal(m.message.fromAddress, "no-reply@us.greenhouse-mail.io");
    assert.equal(m.message.fromName, "Acme Robotics");
    assert.deepEqual(m.message.to, [APPLICANT_A]);
    assert.equal(m.message.date, "2026-10-05T09:30:00.000Z");
    assert.equal(m.message.messageId, "<m-gh-1@greenhouse-mail.io>");
    assert.match(m.message.text, /Senior Backend Engineer/);
    assert.equal(m.envelopeDate, null);
  });

  it("fingerprints identical bytes identically and different bytes differently", async () => {
    const a = await parseEml(
      bytes(buildEml({ ...greenhouseConfirmation(), messageId: "<same@x>" })),
    );
    const b = await parseEml(
      bytes(buildEml({ ...greenhouseConfirmation(), messageId: "<same@x>" })),
    );
    const c = await parseEml(
      bytes(buildEml({ ...greenhouseConfirmation(), messageId: "<other@x>" })),
    );
    assert.equal(a[0]!.fingerprint, b[0]!.fingerprint);
    assert.notEqual(a[0]!.fingerprint, c[0]!.fingerprint);
    assert.match(a[0]!.fingerprint, /^[0-9a-f]{64}$/);
  });

  it("converts HTML-only bodies to text and keeps link targets, without fetching anything", async () => {
    const raw = buildEml({
      from: "Jobs <jobs@acme.example>",
      to: APPLICANT_A,
      subject: "Hello",
      text: "",
      html: '<html><head><style>p{}</style></head><body><p>Apply &amp; track</p><a href="https://boards.greenhouse.io/acme/jobs/1">View job</a><script>alert(1)</script></body></html>',
    });
    const [m] = await parseEml(bytes(raw));
    assert.match(m!.message.text, /Apply & track/);
    assert.match(
      m!.message.text,
      /https:\/\/boards\.greenhouse\.io\/acme\/jobs\/1/,
    );
    assert.doesNotMatch(m!.message.text, /alert\(1\)|p\{\}/);
  });

  it("reports a missing Date as null instead of inventing one", async () => {
    const [m] = await parseEml(
      bytes(buildEml({ ...greenhouseConfirmation(), date: null })),
    );
    assert.equal(m!.message.date, null);
  });
  it("does not invent a timezone for an ambiguous local Date header", async () => {
    const [m] = await parseEml(
      bytes(
        buildEml({
          ...greenhouseConfirmation(),
          date: "Mon, 05 Oct 2026 09:30:00",
        }),
      ),
    );
    assert.equal(m!.message.date, null);
  });
});

describe("parseEml: forwarded as attachment", () => {
  it("returns each attached original separately and keeps the envelope date apart", async () => {
    const forwarded = forwardAsAttachment([
      buildEml(greenhouseConfirmation()),
      buildEml(interviewInvite()),
    ]);
    const out = await parseEml(bytes(forwarded));
    assert.equal(out.length, 2);
    assert.equal(out[0]!.message.fromAddress, "no-reply@us.greenhouse-mail.io");
    assert.equal(out[1]!.message.fromAddress, "dana.lee@acmerobotics.example");
    assert.equal(out[0]!.envelopeDate, "2026-10-09T18:00:00.000Z");
    assert.notEqual(
      out[0]!.message.date,
      out[0]!.envelopeDate,
      "submission time must never be the forward time",
    );
    assert.deepEqual(
      out[0]!.message.to,
      [APPLICANT_A],
      "applicant is the original recipient, not the forward target",
    );
  });

  it("produces the same fingerprint whether the original is sent directly or forwarded", async () => {
    const original = buildEml(greenhouseConfirmation());
    const direct = await parseEml(bytes(original));
    const viaForward = await parseEml(bytes(forwardAsAttachment([original])));
    assert.equal(direct[0]!.fingerprint, viaForward[0]!.fingerprint);
  });
});

describe("parseEml: refusals", () => {
  it("rejects inline forwards because their headers can be rewritten", async () => {
    const inline = buildEml({
      from: "Me <me@personal.example.com>",
      to: "jobs@example.org",
      subject: "Fwd: Thank you for applying",
      text: "---------- Forwarded message ---------\nFrom: x\nThank you for applying",
    });
    await assert.rejects(
      parseEml(bytes(inline)),
      (e: unknown) => e instanceof EmlError && e.code === "INLINE_FORWARD",
    );
  });

  it("rejects oversized input before parsing", async () => {
    const big = new Uint8Array(EML_LIMITS.maxBytes + 1);
    await assert.rejects(
      parseEml(big),
      (e: unknown) => e instanceof EmlError && e.code === "TOO_LARGE",
    );
  });

  it("rejects empty or non-message input", async () => {
    await assert.rejects(
      parseEml(new Uint8Array()),
      (e: unknown) => e instanceof EmlError && e.code === "EMPTY",
    );
    await assert.rejects(
      parseEml(bytes("just some text, no headers")),
      (e: unknown) => e instanceof EmlError && e.code === "NOT_A_MESSAGE",
    );
  });

  it("caps how many originals one file may carry", async () => {
    const originals = Array.from(
      { length: EML_LIMITS.maxOriginals + 1 },
      (_, i) =>
        buildEml({ ...greenhouseConfirmation(), messageId: `<n${i}@x>` }),
    );
    await assert.rejects(
      parseEml(bytes(forwardAsAttachment(originals))),
      (e: unknown) => e instanceof EmlError && e.code === "TOO_MANY",
    );
  });

  it("does not recurse into a message attached inside an attached original", async () => {
    const inner = buildEml(greenhouseConfirmation());
    const middle = forwardAsAttachment([inner]);
    const outer = forwardAsAttachment([middle]);
    const out = await parseEml(bytes(outer));
    assert.equal(out.length, 1);
    assert.match(
      out[0]!.message.subject,
      /Fwd: job emails/,
      "the middle envelope is treated as the original, never unwrapped further",
    );
  });
});

describe("redactSubject", () => {
  it("removes links, long numbers and token-like strings and caps length", () => {
    const out = redactSubject(
      "Verify https://x.example/reset?t=abc123 code 482913 token AbCdEfGhIjKlMnOpQrStUvWx " +
        "z".repeat(300),
    );
    assert.doesNotMatch(out, /https?:|482913|AbCdEfGhIjKlMnOpQrStUvWx/);
    assert.ok(out.length <= 120);
  });
  it("leaves ordinary subjects intact", () => {
    assert.equal(
      redactSubject("Thank  you for applying to Acme"),
      "Thank you for applying to Acme",
    );
  });
});
