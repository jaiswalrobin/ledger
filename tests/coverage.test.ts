import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  deriveCoverage,
  describeActivity,
  maskEmail,
} from "../src/domain/coverage.ts";
import { parseEml } from "../src/ingestion/eml.ts";
import type { Db } from "../src/server/db.ts";
import { ingestOriginal, type IngestSource } from "../src/server/pipeline.ts";
import {
  getOpening,
  listMailboxes,
  listOpenings,
  listReviews,
} from "../src/server/queries.ts";
import { buildEml, type EmlSpec } from "./helpers/eml.ts";
import {
  createTestDb,
  seedMailbox,
  seedUser,
  type TestDb,
} from "./helpers/db.ts";
import {
  APPLICANT_A,
  greenhouseConfirmation,
  interviewInvite,
  newsletter,
} from "./helpers/fixtures.ts";

describe("deriveCoverage", () => {
  it("no Gmail source means forwarded/manual, never 'monitored'", () => {
    assert.equal(deriveCoverage([]), "FORWARD_OR_MANUAL");
  });
  it("a healthy, fully backfilled mailbox is continuous", () => {
    assert.equal(
      deriveCoverage([{ syncState: "HEALTHY", backfillComplete: true }]),
      "CONTINUOUS_HEALTHY",
    );
  });
  it("a healthy mailbox whose backfill is unfinished says so", () => {
    assert.equal(
      deriveCoverage([{ syncState: "HEALTHY", backfillComplete: false }]),
      "BACKFILL_INCOMPLETE",
    );
  });
  it("degraded, resyncing and initialising mailboxes are degraded", () => {
    for (const syncState of [
      "DEGRADED",
      "RESYNC_REQUIRED",
      "INITIALIZING",
    ] as const) {
      assert.equal(
        deriveCoverage([{ syncState, backfillComplete: true }]),
        "CONTINUOUS_DEGRADED",
      );
    }
  });
  it("the least healthy observing mailbox wins", () => {
    assert.equal(
      deriveCoverage([
        { syncState: "HEALTHY", backfillComplete: true },
        { syncState: "DISCONNECTED", backfillComplete: true },
      ]),
      "DISCONNECTED",
    );
  });
});

describe("describeActivity", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  it("never claims rejection from silence and always names the coverage", () => {
    const healthy = describeActivity(
      "2026-10-11T09:00:00Z",
      now,
      "CONTINUOUS_HEALTHY",
    );
    assert.match(
      healthy,
      /^No response observed in connected sources since 11 Oct 2026 \(9 days\)/,
    );
    assert.doesNotMatch(healthy, /reject/i);
  });
  it("does not assert 'no response' for unmonitored attempts", () => {
    const text = describeActivity(
      "2026-10-11T09:00:00Z",
      now,
      "FORWARD_OR_MANUAL",
    );
    assert.match(text, /not continuously monitored/i);
    assert.doesNotMatch(text, /No response observed/);
  });
  it("handles an attempt with no activity yet", () => {
    assert.match(
      describeActivity(null, now, "CONTINUOUS_HEALTHY"),
      /no activity recorded/i,
    );
  });
});

describe("maskEmail", () => {
  it("keeps the domain and hides most of the local part", () => {
    assert.equal(maskEmail("robin.a@example.com"), "ro***@example.com");
    assert.equal(maskEmail("a@example.com"), "a***@example.com");
    assert.equal(maskEmail(null), "unknown");
  });
});

describe("read models", () => {
  let t: TestDb;
  let db: Db;
  before(async () => {
    t = await createTestDb();
    db = t.db;
  });
  after(() => t.close());

  async function ingest(userId: string, spec: EmlSpec, source: IngestSource) {
    const [original] = await parseEml(new TextEncoder().encode(buildEml(spec)));
    return ingestOriginal(db, { userId, source, original: original! });
  }

  it("lists openings with attempts, masked applicant, derived coverage and evidence provenance", async () => {
    const u = await seedUser(db);
    const mailbox = await seedMailbox(db, u, "jobs@example.org");
    await db.query(
      "UPDATE connected_mailboxes SET sync_state = 'HEALTHY', backfill_complete = true,last_success_at='2026-10-20T12:00:00Z' WHERE id = $1",
      [mailbox],
    );
    await ingest(
      u,
      greenhouseConfirmation(APPLICANT_A, undefined, "a", "GH-1"),
      { kind: "GMAIL", mailboxId: mailbox, providerMessageId: "gm-1" },
    );
    await ingest(u, interviewInvite(APPLICANT_A, undefined, "GH-1"), {
      kind: "FORWARDED_EML",
    });

    const openings = await listOpenings(
      db,
      u,
      new Date("2026-10-20T12:00:00Z"),
    );
    assert.equal(openings.length, 1);
    const o = openings[0]!;
    assert.equal(o.company, "Acme Robotics");
    assert.equal(o.attempts.length, 1);
    const a = o.attempts[0]!;
    assert.equal(a.applicantEmailMasked, "ro***@example.com");
    assert.equal(a.stage, "INTERVIEW");
    assert.equal(a.coverage, "CONTINUOUS_HEALTHY");
    assert.match(a.activity, /connected sources|since/i);

    const detail = await getOpening(
      db,
      u,
      o.id,
      new Date("2026-10-20T12:00:00Z"),
    );
    assert.ok(detail);
    const events = detail.attempts[0]!.events;
    assert.deepEqual(
      events.map((e) => e.kind),
      ["CONFIRMATION_RECEIVED", "INTERVIEW_INVITED"],
    );
    assert.equal(events[0]!.evidence[0]!.sourceKind, "GMAIL");
    assert.equal(events[0]!.evidence[0]!.mailboxAddress, "jobs@example.org");
    assert.equal(events[1]!.evidence[0]!.sourceKind, "FORWARDED_EML");
    assert.match(
      events[0]!.evidence[0]!.subject ?? "",
      /Thank you for applying/,
    );
  });

  it("a forwarded-only attempt is labelled as not continuously monitored", async () => {
    const u = await seedUser(db);
    await ingest(u, greenhouseConfirmation(), { kind: "FORWARDED_EML" });
    const [o] = await listOpenings(db, u, new Date("2026-10-20T12:00:00Z"));
    assert.equal(o!.attempts[0]!.coverage, "FORWARD_OR_MANUAL");
    assert.match(o!.attempts[0]!.activity, /not continuously monitored/i);
  });

  it("never returns another user's openings or reviews", async () => {
    const a = await seedUser(db);
    const b = await seedUser(db);
    await ingest(a, greenhouseConfirmation(), { kind: "FORWARDED_EML" });
    await ingest(a, newsletter(), { kind: "FORWARDED_EML" });
    assert.equal((await listOpenings(db, b)).length, 0);
    assert.equal((await listReviews(db, b)).length, 0);
    const [opening] = await listOpenings(db, a);
    assert.equal(await getOpening(db, b, opening!.id), null);
  });

  it("lists open reviews with a safe subject, the reason code and candidate attempts", async () => {
    const u = await seedUser(db);
    await ingest(u, greenhouseConfirmation(APPLICANT_A, undefined, "a", null), {
      kind: "FORWARDED_EML",
    });
    await ingest(
      u,
      greenhouseConfirmation(
        APPLICANT_A,
        "Tue, 06 Oct 2026 10:00:00 +0000",
        "b",
        null,
      ),
      { kind: "FORWARDED_EML" },
    );
    const reviews = await listReviews(db, u);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]!.reason, "POSSIBLE_RESENT_CONFIRMATION");
    assert.equal(reviews[0]!.candidates.length, 1);
    assert.equal(
      reviews[0]!.candidates[0]!.openingTitle,
      "Senior Backend Engineer",
    );
    assert.equal(reviews[0]!.kind, "CONFIRMATION_RECEIVED");
  });

  it("lists mailboxes with sync health and the last run's counters", async () => {
    const u = await seedUser(db);
    const mailbox = await seedMailbox(db, u, "jobs@example.org");
    await db.query(
      `INSERT INTO sync_runs (id, mailbox_id, kind, state, finished_at, discovered_count, bodies_fetched)
       VALUES (gen_random_uuid(), $1, 'BACKFILL', 'COMPLETED', now(), 12, 4)`,
      [mailbox],
    );
    const [m] = await listMailboxes(db, u);
    assert.equal(m!.address, "jobs@example.org");
    assert.equal(m!.lastRun?.discovered, 12);
    assert.equal(m!.lastRun?.bodiesFetched, 4);
  });
});
