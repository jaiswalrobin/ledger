import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { extractSignal } from "../src/ingestion/extract.ts";
import { parseEml } from "../src/ingestion/eml.ts";
import { classifyHeaders } from "../src/ingestion/header-gate.ts";
import { hasSensitiveContent, sensitivity } from "../src/ingestion/privacy.ts";
import { htmlText } from "../src/ingestion/html.ts";
import { senderDomain } from "../src/ingestion/ats.ts";
import { ingestOriginal } from "../src/server/pipeline.ts";
import { syncMailbox, type SyncDeps } from "../src/server/gmail/sync.ts";
import {
  candidateQueries,
  phraseCheckQuery,
} from "../src/server/gmail/client.ts";
import type { Db } from "../src/server/db.ts";
import { buildEml, forwardAsAttachment, type EmlSpec } from "./helpers/eml.ts";
import { FakeGmail } from "./helpers/fake-gmail.ts";
import {
  createTestDb,
  seedMailbox,
  seedUser,
  type TestDb,
} from "./helpers/db.ts";
import {
  APPLICANT_A,
  greenhouseConfirmation,
  rejection,
} from "./helpers/fixtures.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
async function extract(spec: EmlSpec) {
  const [parsed] = await parseEml(bytes(buildEml(spec)));
  return extractSignal(parsed!.message);
}
const base = (text: string, subject = "Hello"): EmlSpec => ({
  from: '"Acme Robotics" <no-reply@us.greenhouse-mail.io>',
  to: APPLICANT_A,
  subject,
  date: "Mon, 05 Oct 2026 09:30:00 +0000",
  text,
});

describe("recall: kind detection survives real-world formatting", () => {
  it("typographic apostrophes", async () => {
    const s = await extract(
      base("We’d like to offer you the Senior Backend Engineer position."),
    );
    assert.equal(s.kind, "OFFER_RECEIVED");
  });

  it("phrases split by hard line wrapping and non-breaking spaces", async () => {
    const s = await extract(
      base(
        "Hi Robin,\n\nThank you for\napplying to Acme Robotics. We have\nreceived your application.",
      ),
    );
    assert.equal(s.kind, "CONFIRMATION_RECEIVED");
  });

  it("common confirmation phrasings", async () => {
    for (const text of [
      "Your application was sent to Acme Robotics.",
      "We got your application for the Data Engineer role.",
      "You've applied for Data Engineer at Acme Robotics.",
      "Application confirmation for Data Engineer.",
      "Your application has been successfully submitted.",
    ])
      assert.equal(
        (await extract(base(text))).kind,
        "CONFIRMATION_RECEIVED",
        text,
      );
  });

  it("common rejection phrasings", async () => {
    for (const text of [
      "We won't be moving forward with your application.",
      "We have decided to pursue other candidates for this role.",
      "Your application was unsuccessful on this occasion.",
      "We will not be progressing your application further.",
      "The position has been filled.",
      "We have selected another candidate whose experience more closely matches.",
    ])
      assert.equal(
        (await extract(base(text))).kind,
        "REJECTION_RECEIVED",
        text,
      );
  });

  it("common interview and assessment phrasings", async () => {
    const cases: [string, string][] = [
      [
        "We would love to schedule a call to learn more about you.",
        "INTERVIEW_INVITED",
      ],
      [
        "Please share your availability for an interview next week.",
        "INTERVIEW_INVITED",
      ],
      ["We'd like to move you forward to the next round.", "INTERVIEW_INVITED"],
      [
        "Your interview has been rescheduled to Thursday.",
        "INTERVIEW_SCHEDULED",
      ],
      [
        "You have been invited to complete a HackerRank test.",
        "ASSESSMENT_INVITED",
      ],
      [
        "Please complete the technical assessment within 3 days.",
        "ASSESSMENT_INVITED",
      ],
    ];
    for (const [text, kind] of cases)
      assert.equal((await extract(base(text))).kind, kind, text);
  });

  it("calendar invitations are scheduled interviews", async () => {
    const s = await extract(
      base(
        "Join with Google Meet",
        "Invitation: Interview with Acme Robotics @ Tue Oct 13, 2026 10am - 11am (UTC)",
      ),
    );
    assert.equal(s.kind, "INTERVIEW_SCHEDULED");
  });

  it("a post-interview rejection is proposed as a rejection, but never with high confidence", async () => {
    const s = await extract(
      base(
        "Thank you for taking the time to interview with us. Following your interview with the team, we have decided to move forward with other candidates.",
      ),
    );
    assert.equal(s.kind, "REJECTION_RECEIVED");
    assert.equal(s.confidence, "LOW");
  });

  it("a stub text part does not hide the HTML part", async () => {
    const s = await extract({
      ...base("To view this email, open it in an HTML-capable client."),
      html: "<html><head><title>x</title><body><p>Thank you for applying to Acme Robotics!</p><p>We&rsquo;ve received your application for the <b>Data Engineer</b> role.</p></body></html>",
    });
    assert.equal(s.kind, "CONFIRMATION_RECEIVED");
    assert.equal(s.confidence, "HIGH");
    assert.equal(s.fields.company, "Acme Robotics");
  });

  it("keeps real titles that contain a status word", async () => {
    const s = await extract(
      base("Job Title: Application Security Engineer\nThank you for applying."),
    );
    assert.equal(s.fields.title, "Application Security Engineer");
  });

  it("recovers title and company from a hard-wrapped sentence", async () => {
    const s = await extract(
      base(
        "Thank you for applying for the Senior Backend\nEngineer position at Acme Robotics. We will be in touch.",
      ),
    );
    assert.equal(s.fields.title, "Senior Backend Engineer");
    assert.equal(s.fields.company, "Acme Robotics");
  });

  it("EU Lever job links are recognised", async () => {
    const s = await extract(
      base(
        "Thanks for applying. https://jobs.eu.lever.co/northwind/6f1c1c2e-aaaa-4bbb-8ccc-0123456789ab/apply",
      ),
    );
    assert.equal(s.fields.atsKey?.provider, "lever");
  });
});

describe("recall: sensitive screening targets credentials, not ordinary links", () => {
  it("does not drop interview mail with a meeting passcode", () => {
    assert.equal(
      hasSensitiveContent(
        "Join Zoom Meeting https://zoom.us/j/123?pwd=abc\nMeeting ID: 123 456\nPasscode: 8Hk2pQ",
      ),
      false,
    );
  });
  it("does not drop mail with tracking or unsubscribe tokens", () => {
    assert.equal(
      hasSensitiveContent(
        "Tracking https://u.example.com/track?token=AbC123\nUnsubscribe https://u.example.com/unsub?key=zzz&sig=yyy",
      ),
      false,
    );
  });
  it("still drops credential deliveries", () => {
    for (const text of [
      "Your verification code is 123456",
      "Your passcode is 552211",
      "Click to reset your password",
      "Sign in: https://acme.example/login?token=abc",
      "https://acme.example/magic?auth=1 use this magic link",
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghij",
      "https://app.greenhouse.io/applications/status?token=opaque-access",
      "https://example.org/s%69gnin?%74oken=opaque-access",
      "https://example.org/unsubscribe?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghij",
      "Your veri\u200bfication code is 123456",
    ])
      assert.equal(hasSensitiveContent(text), true, text);
  });
});

describe("sensitivity levels separate access links from credential deliveries", () => {
  it("hiring links with opaque tokens are access links, not credentials", () => {
    for (const url of [
      "https://www.hackerrank.com/tests/abc123/login?b=eyJ0b2tlbiI6&token=Zx81",
      "https://app.codesignal.com/test/xyz?key=Ab12Cd34",
      "https://app.greenhouse.io/applications/status?token=opaque-access",
      "https://calendly.com/d/abc-123/interview?ticket=xyz",
    ])
      assert.equal(sensitivity(`Start here: ${url}`), "ACCESS_LINK", url);
  });
  it("click tracking and signed assets are ordinary", () => {
    for (const url of [
      "https://track.example.com/c/AbCdEf0123456789?sig=zzz",
      "https://u.example.com/ls/click?upn=abc&sig=def",
      "https://cdn.example.com/logo.png?Signature=abc&Expires=1",
    ])
      assert.equal(sensitivity(url), "NONE", url);
  });
  it("account changes, raw secrets and bearer tokens are credentials", () => {
    for (const text of [
      "https://acme.example/reset-password?token=abc",
      "https://acme.example/verify-email?token=abc",
      "https://acme.example/portal?access_token=abc",
      "Your verification code is 123456",
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghij",
    ])
      assert.equal(sensitivity(text), "CREDENTIAL", text);
  });
});

describe("recall: header gate", () => {
  it("accepts plural and inflected recruitment words", () => {
    for (const subject of [
      "Interviews with Acme",
      "Interviewing at Acme Robotics",
      "Your applications",
      "Next steps with Acme",
      "Acme opportunity",
      "Thanks for your interest in Acme",
      "Your candidacy at Acme",
    ])
      assert.equal(
        classifyHeaders({ from: "talent@acme.example", subject }).kind,
        "CANDIDATE",
        subject,
      );
  });
  it("accepts neutral subjects from hiring platforms, but not account mail", () => {
    assert.equal(
      classifyHeaders({
        from: '"Acme" <no-reply@us.greenhouse-mail.io>',
        subject: "Acme Robotics – Senior Engineer",
      }).kind,
      "CANDIDATE",
    );
    assert.equal(
      classifyHeaders({
        from: "noreply@hackerrank.com",
        subject: "Acme Robotics has invited you",
      }).kind,
      "CANDIDATE",
    );
    assert.equal(
      classifyHeaders({
        from: "noreply@greenhouse.io",
        subject: "Reset your password",
      }).kind,
      "SKIP_SENSITIVE",
    );
    assert.equal(
      classifyHeaders({
        from: "noreply@greenhouse.io",
        subject: "Your account",
      }).kind,
      "REVIEW_HEADERS",
    );
  });
  it("takes the sender domain from the address, never the display name", () => {
    assert.equal(
      senderDomain(
        '"jobs@evil.example via Greenhouse" <no-reply@greenhouse.io>',
      ),
      "greenhouse.io",
    );
    assert.equal(senderDomain("no-reply@greenhouse.io"), "greenhouse.io");
  });
});

describe("recall: MIME parsing", () => {
  it("accepts .eml attachments sent as application/octet-stream", async () => {
    const original = buildEml(greenhouseConfirmation());
    const out = await parseEml(
      bytes(
        buildEml({
          from: "me@example.com",
          to: "jobs@example.org",
          subject: "Fwd",
          text: "",
          attachments: [
            {
              filename: "original.eml",
              mime: "application/octet-stream",
              content: original,
            },
          ],
        }),
      ),
    );
    assert.equal(out.length, 1);
    assert.equal(
      out[0]!.message.subject,
      "Thank you for applying to Acme Robotics",
    );
  });

  it("one damaged attachment does not discard valid siblings", async () => {
    const good = buildEml(greenhouseConfirmation());
    const out = await parseEml(
      bytes(forwardAsAttachment([good, "not a message at all"])),
    );
    assert.equal(out.length, 1);
    assert.deepEqual(out[0]!.omittedOriginals, ["NOT_A_MESSAGE"]);
  });

  it("keeps a missing Date unknown even when Received timestamps exist", async () => {
    const raw = buildEml({ ...greenhouseConfirmation(), date: null }).replace(
      "From:",
      "Received: by mx.example.com; Mon, 05 Oct 2026 09:31:00 +0000\r\nReceived: from relay.example.com; Mon, 05 Oct 2026 09:30:05 +0000\r\nFrom:",
    );
    const [out] = await parseEml(bytes(raw));
    assert.equal(out!.message.date, null);
  });

  it("accepts a UTC zone name", async () => {
    const [out] = await parseEml(
      bytes(
        buildEml({
          ...greenhouseConfirmation(),
          date: "Mon, 05 Oct 2026 09:30:00 UTC",
        }),
      ),
    );
    assert.equal(out!.message.date, "2026-10-05T09:30:00.000Z");
  });

  it("does not refuse a mail-merge with many visible recipients", async () => {
    const to = Array.from({ length: 80 }, (_, i) => `person${i}@example.com`);
    const [out] = await parseEml(
      bytes(buildEml({ ...greenhouseConfirmation(), to })),
    );
    assert.equal(out!.message.to.length, 80);
  });

  it("keeps the body when <head> is never closed and decodes typographic entities", () => {
    const text = htmlText(
      "<html><head><meta charset=utf-8><body><p>We&rsquo;d like to offer you the role&hellip;</p>",
    );
    assert.match(text, /We’d like to offer you the role…/);
  });
});

describe("recall: discovery queries", () => {
  it("cover more hiring platforms, inflections, body phrases and authenticated spam", () => {
    const qs = candidateQueries(1_700_000_000).join("\n");
    for (const needle of [
      "from:taleo.net",
      "from:hackerrank.com",
      "interviews",
      "applications",
      '"thank you for applying"',
      "in:spam",
    ])
      assert.ok(qs.includes(needle), needle);
  });
  it("only embeds safe Message-IDs in a phrase check", () => {
    assert.match(
      phraseCheckQuery("<abc.123@mail.example.com>")!,
      /^rfc822msgid:abc\.123@mail\.example\.com in:anywhere \(/,
    );
    assert.equal(phraseCheckQuery('<a b"c@x>'), null);
    assert.equal(phraseCheckQuery("<x) OR (in:inbox@x>"), null);
  });
});

describe("recall: pipeline and sync", () => {
  let t: TestDb;
  let db: Db;
  before(async () => {
    t = await createTestDb();
    db = t.db;
  });
  after(() => t.close());
  const NOW = new Date("2026-10-20T12:00:00Z");
  const deps = (fake: FakeGmail): SyncDeps => ({
    db,
    clientFor: async () => fake,
    now: () => NOW,
    budgetMs: 60_000,
  });
  const outcomes = async (mailboxId: string) =>
    Object.fromEntries(
      (
        await db.query<{ provider_message_id: string; outcome: string }>(
          "SELECT provider_message_id, outcome FROM processing_tasks WHERE mailbox_id=$1",
          [mailboxId],
        )
      ).rows.map((r) => [r.provider_message_id, r.outcome]),
    );

  it("an ambiguous synced message becomes a review item instead of being dismissed", async () => {
    const user = await seedUser(db);
    const mailbox = await seedMailbox(db, user);
    const [original] = await parseEml(
      bytes(
        buildEml(
          base(
            "We regret to inform you the role is filled. We are pleased to offer you a different role.",
            "Your application",
          ),
        ),
      ),
    );
    const out = await ingestOriginal(db, {
      userId: user,
      source: {
        kind: "GMAIL",
        mailboxId: mailbox,
        providerMessageId: "amb-1",
        senderAuthenticated: true,
      },
      original: original!,
      observedAt: NOW,
    });
    assert.equal(out.status, "REVIEW");
  });

  it("a low-confidence rejection never changes an outcome automatically", async () => {
    const user = await seedUser(db);
    const mailbox = await seedMailbox(db, user);
    const ingest = async (spec: EmlSpec, id: string) => {
      const [original] = await parseEml(bytes(buildEml(spec)));
      return ingestOriginal(db, {
        userId: user,
        source: {
          kind: "GMAIL",
          mailboxId: mailbox,
          providerMessageId: id,
          senderAuthenticated: true,
        },
        original: original!,
        observedAt: NOW,
      });
    };
    assert.equal(
      (await ingest(greenhouseConfirmation(), "c1")).status,
      "APPLIED",
    );
    const mixed = rejection();
    mixed.text = mixed.text!.replace(
      "Unfortunately,",
      "Following your interview with the team, unfortunately,",
    );
    const out = await ingest(mixed, "r1");
    assert.equal(out.status, "REVIEW");
    if (out.status === "REVIEW")
      assert.equal(out.reason, "TERMINAL_NEEDS_REVIEW");
  });

  it("recruiter mail with an unhelpful subject is fetched when Gmail finds a recruitment phrase", async () => {
    const user = await seedUser(db);
    const mailbox = await seedMailbox(db, user);
    const fake = new FakeGmail();
    fake.add("chat", {
      from: '"Dana Lee" <dana.lee@acmerobotics.example>',
      to: APPLICANT_A,
      subject: "Quick chat?",
      date: "Mon, 12 Oct 2026 14:00:00 +0000",
      messageId: "<chat-1@acmerobotics.example>",
      text: "Hi Robin, thank you for applying. We would like to invite you to interview for the Data Engineer role at Acme Robotics.",
    });
    fake.add("lunch", {
      from: '"Friend" <friend@example.com>',
      to: APPLICANT_A,
      subject: "Lunch?",
      date: "Mon, 12 Oct 2026 14:00:00 +0000",
      messageId: "<lunch-1@example.com>",
      text: "Are you free on Friday?",
    });
    await syncMailbox(deps(fake), mailbox, { system: true });
    assert.deepEqual(fake.calls.raw, ["chat"]);
    const o = await outcomes(mailbox);
    assert.equal(o["chat"], "PROCESSED");
    assert.equal(o["lunch"], "SKIPPED_UNRELATED");
  });

  it("spam is processed only for authenticated hiring-platform senders", async () => {
    const user = await seedUser(db);
    const mailbox = await seedMailbox(db, user);
    const fake = new FakeGmail();
    fake.add("ats-spam", greenhouseConfirmation(), ["SPAM"]);
    fake.add(
      "scam-spam",
      {
        ...greenhouseConfirmation(),
        from: '"Acme" <jobs@scam.example>',
        messageId: "<scam@scam.example>",
      },
      ["SPAM"],
    );
    await syncMailbox(deps(fake), mailbox, { system: true });
    const o = await outcomes(mailbox);
    assert.equal(o["ats-spam"], "PROCESSED");
    assert.equal(o["scam-spam"], "SKIPPED_SPAM");
  });
});
