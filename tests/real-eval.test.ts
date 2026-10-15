import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  evaluateReal,
  judge,
  labelEmails,
  readLabels,
  topLevelHeaders,
  type Labels,
} from "./corpus/real.ts";
import { buildEml } from "./helpers/eml.ts";

/** Gmail's own verdict, folded across lines as in a real download. */
const authenticated = (domain: string) =>
  `Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@${domain};\r\n       dmarc=pass (p=REJECT) header.from=${domain}\r\n`;

const confirmation = buildEml({
  from: "Acme Careers <no-reply@greenhouse.io>",
  to: "me@example.com",
  subject: "Thank you for applying to Acme",
  date: "Mon, 05 Oct 2026 09:30:00 +0000",
  messageId: "<confirm@example.com>",
  text: "Thank you for applying to the Backend Engineer position at Acme. We have received your application.",
});
const rejection = buildEml({
  from: "Acme Careers <no-reply@greenhouse.io>",
  to: "me@example.com",
  subject: "Your application to Acme",
  date: "Mon, 19 Oct 2026 09:30:00 +0000",
  messageId: "<reject@example.com>",
  text: "Thank you for your interest in the Backend Engineer position at Acme. Unfortunately, we have decided not to move forward with your application.",
});
const newsletter = buildEml({
  from: "Weekly <news@newsletter.example>",
  to: "me@example.com",
  subject: "This week in tech",
  date: "Tue, 06 Oct 2026 09:30:00 +0000",
  messageId: "<news@example.com>",
  text: "Ten stories you missed this week.",
});

async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ledger-real-eval-"));
  for (const [name, content] of Object.entries(files))
    await writeFile(join(dir, name), content);
  return dir;
}

it("reads top-level headers only, unfolding continuation lines", () => {
  const raw = new TextEncoder().encode(
    `${authenticated("greenhouse.io")}${confirmation}`,
  );
  const headers = topLevelHeaders(raw);
  assert.equal(
    headers.find((h) => h.name === "Authentication-Results")?.value,
    "mx.google.com; dkim=pass header.i=@greenhouse.io; dmarc=pass (p=REJECT) header.from=greenhouse.io",
  );
  assert.equal(headers.filter((h) => h.name === "From").length, 1);
  assert.ok(
    !headers.some(
      (h) => h.name === "Content-Transfer-Encoding" && h.value === "base64",
    ),
    "body headers excluded",
  );
});

it("label pre-fills new emails from the extractor, unverified, and never overwrites a checked label", async () => {
  const dir = await folder({
    "1-confirm.eml": confirmation,
    "2-news.eml": newsletter,
  });
  try {
    await writeFile(
      join(dir, "labels.json"),
      JSON.stringify({
        "2-news.eml": {
          verified: true,
          kind: null,
          company: null,
          title: null,
          note: "mine",
        },
      }),
    );
    const result = await labelEmails(dir);
    assert.deepEqual(result.added, ["1-confirm.eml"]);
    const labels = await readLabels(dir);
    assert.deepEqual(labels["1-confirm.eml"], {
      verified: false,
      kind: "CONFIRMATION_RECEIVED",
      company: "Acme",
      title: "Backend Engineer",
      job: null,
    });
    assert.deepEqual(labels["2-news.eml"], {
      verified: true,
      kind: null,
      company: null,
      title: null,
      job: null,
      note: "mine",
    });
    assert.ok(
      !(await readFile(join(dir, "labels.json"), "utf8")).includes(
        "received your application",
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("scores verified labels through the real pipeline in date order, using Gmail's sender verdict", async () => {
  const labels: Labels = {
    // File names sort against the dates: ingestion must follow the Date header.
    "a-reject.eml": {
      verified: true,
      kind: "REJECTION_RECEIVED",
      company: "Acme",
      title: "Backend Engineer",
      job: null,
    },
    "b-confirm.eml": {
      verified: true,
      kind: "CONFIRMATION_RECEIVED",
      company: "Acme",
      title: "Backend Engineer",
      job: null,
    },
    "c-news.eml": {
      verified: true,
      kind: null,
      company: null,
      title: null,
      job: null,
    },
  };
  const run = async (rejectionHeaders: string) => {
    const dir = await folder({
      "a-reject.eml": `${rejectionHeaders}${rejection}`,
      "b-confirm.eml": `${authenticated("greenhouse.io")}${confirmation}`,
      "c-news.eml": newsletter,
      "labels.json": JSON.stringify(labels),
    });
    try {
      return await evaluateReal(dir, new Date("2026-10-20T12:00:00Z"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  const report = await run(authenticated("greenhouse.io"));
  assert.equal(report.verified, 3);
  assert.deepEqual(
    report.extraction.map((r) => r.verdicts),
    [
      { kind: "correct", company: "correct", title: "correct" },
      { kind: "correct", company: "correct", title: "correct" },
      { kind: "correct", company: "correct", title: "correct" },
    ],
  );
  assert.deepEqual(
    Object.fromEntries(report.outcomes.map((o) => [o.file, o.judgement])),
    {
      "a-reject.eml": "applied-correctly",
      "b-confirm.eml": "applied-correctly",
      "c-news.eml": "ignored",
    },
  );

  // Without Gmail's authentication, a rejection from a hiring platform is never applied alone.
  const unauthenticated = await run("");
  const reject = unauthenticated.outcomes.find(
    (o) => o.file === "a-reject.eml",
  )!;
  assert.equal(reject.judgement, "review");
  assert.deepEqual(reject.state, {
    status: "REVIEW",
    reason: "TERMINAL_NEEDS_REVIEW",
  });
});

it("judges any automatic change that contradicts the label as wrong", () => {
  const label = {
    verified: true,
    kind: "REJECTION_RECEIVED" as const,
    company: "Acme",
    title: "Backend Engineer",
    job: null,
  };
  const applied = (kind: string, company: string, title: string) => ({
    status: "APPLIED" as const,
    events: [{ kind, company, title }],
  });
  assert.equal(
    judge(
      label,
      applied("REJECTION_RECEIVED", "ACME Inc.", "backend engineer"),
    ),
    "applied-correctly",
  );
  assert.equal(
    judge(label, applied("OFFER_RECEIVED", "Acme", "Backend Engineer")),
    "applied-wrongly",
  );
  assert.equal(
    judge(label, applied("REJECTION_RECEIVED", "Globex", "Backend Engineer")),
    "applied-wrongly",
  );
  assert.equal(
    judge(label, applied("REJECTION_RECEIVED", "Acme", "Data Engineer")),
    "applied-wrongly",
  );
  // A rejection that names no role: landing on any Acme job must not count as correct.
  const untitled = { ...label, title: null };
  assert.equal(
    judge(untitled, applied("REJECTION_RECEIVED", "Acme", "Data Engineer")),
    "applied-unverified",
  );
  const job = { company: "Acme", title: "Backend Engineer" };
  assert.equal(
    judge(
      { ...untitled, job },
      applied("REJECTION_RECEIVED", "Acme", "Data Engineer"),
    ),
    "applied-wrongly",
  );
  assert.equal(
    judge(
      { ...untitled, job },
      applied("REJECTION_RECEIVED", "Acme", "Backend Engineer"),
    ),
    "applied-correctly",
  );
  assert.equal(
    judge(untitled, applied("OFFER_RECEIVED", "Acme", "Data Engineer")),
    "applied-wrongly",
  );
  assert.equal(
    judge(
      { ...label, kind: null },
      applied("REJECTION_RECEIVED", "Acme", "Backend Engineer"),
    ),
    "applied-wrongly",
  );
  assert.equal(judge(label, { status: "NO_SIGNAL" }), "lost");
  assert.equal(judge(label, { status: "SKIPPED_SENSITIVE" }), "lost");
  assert.equal(
    judge(
      { ...label, kind: null },
      { status: "REVIEW", reason: "UNRECOGNIZED" },
    ),
    "review-noise",
  );
});

it("rejects a label whose job is incomplete", async () => {
  const dir = await folder({
    "labels.json": JSON.stringify({
      "x.eml": { verified: true, kind: null, job: { company: "Acme" } },
    }),
  });
  try {
    await assert.rejects(readLabels(dir), /needs both company and title/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
