import assert from "node:assert/strict";
import { it } from "node:test";
import { CORPUS } from "./corpus/emails.ts";
import { FakeGmail } from "./helpers/fake-gmail.ts";
import { createTestDb, seedMailbox, seedUser } from "./helpers/db.ts";
import { syncMailbox } from "../src/server/gmail/sync.ts";
import { companyKey } from "../src/domain/normalization.ts";

it("every positive corpus message survives discovery, header screening, and database ingestion", async () => {
  const t = await createTestDb();
  try {
    const userId = await seedUser(t.db);
    const mailboxId = await seedMailbox(t.db, userId);
    const gmail = new FakeGmail();
    gmail.strictDiscovery = true;
    gmail.pageSize = 100;
    const positives = CORPUS.filter((email) => email.expect.kind !== null);
    for (const email of positives)
      gmail.add(email.id, {
        ...email,
        to: "applicant@example.com",
        date: "Mon, 12 Oct 2026 09:30:00 +0000",
        messageId: `<${email.id}@corpus.example>`,
      });
    const deps = {
      db: t.db,
      clientFor: async () => gmail,
      now: () => new Date("2026-10-20T12:00:00Z"),
      budgetMs: 60_000,
    };
    await syncMailbox(deps, mailboxId, { userId });
    await syncMailbox(deps, mailboxId, { userId });
    const tasks = await t.db.query<{
      provider_message_id: string;
      outcome: string;
    }>(
      "SELECT provider_message_id,outcome FROM processing_tasks WHERE mailbox_id=$1",
      [mailboxId],
    );
    const outcomes = new Map(
      tasks.rows.map((row) => [row.provider_message_id, row.outcome]),
    );
    for (const email of positives) {
      assert.equal(outcomes.get(email.id), "PROCESSED", email.id);
      assert.ok(
        gmail.calls.raw.includes(email.id),
        `${email.id}: body never fetched`,
      );
    }
    // "PROCESSED" covers both applied and review outcomes, so check what was actually decided.
    const { rows } = await t.db.query<{
      id: string;
      state: string;
      reason: string | null;
    }>(
      `SELECT a.provider_message_id AS id, s.processing_state AS state, r.reason_code AS reason
         FROM source_artifacts a
         JOIN extracted_signals s ON s.source_artifact_id = a.id AND s.user_id = a.user_id
         LEFT JOIN review_items r ON r.signal_id = s.id AND r.user_id = s.user_id
        WHERE a.mailbox_id = $1`,
      [mailboxId],
    );
    const decided = new Map(rows.map((row) => [row.id, row]));
    const jobKey = (e: (typeof positives)[number]) =>
      `${companyKey(e.expect.company ?? "")}|${(e.expect.title ?? "").toLowerCase()}`;
    // Confirmations of the same job: the first creates the opening; company and title alone never
    // merge another confirmation into it, so the others wait as AMBIGUOUS_OPENING.
    const duplicates = new Map<string, number>();
    for (const e of positives)
      if (
        e.expect.kind === "CONFIRMATION_RECEIVED" &&
        e.expect.company &&
        e.expect.title
      )
        duplicates.set(jobKey(e), (duplicates.get(jobKey(e)) ?? 0) + 1);
    for (const [key, count] of duplicates) {
      const group = positives.filter(
        (e) =>
          e.expect.kind === "CONFIRMATION_RECEIVED" &&
          e.expect.company &&
          e.expect.title &&
          jobKey(e) === key,
      );
      const states = group.map((e) =>
        decided.get(e.id)?.state === "APPLIED"
          ? "APPLIED"
          : decided.get(e.id)?.reason,
      );
      assert.equal(
        states.filter((x) => x === "APPLIED").length,
        1,
        `${key}: ${states.join(",")}`,
      );
      assert.equal(
        states.filter((x) => x === "AMBIGUOUS_OPENING").length,
        count - 1,
        `${key}: ${states.join(",")}`,
      );
    }
    for (const email of positives) {
      const row = decided.get(email.id);
      assert.ok(row && row.state !== "DISMISSED", `${email.id}: dismissed`);
      // A message without its employer or role can only wait for a person. With both, a
      // confirmation creates its application, and an update joins it when the corpus confirms
      // the same job, or otherwise waits for one.
      const complete = !!email.expect.company && !!email.expect.title;
      const outcome = row.state === "APPLIED" ? "APPLIED" : row.reason;
      const confirmed = positives.some(
        (other) =>
          other.expect.kind === "CONFIRMATION_RECEIVED" &&
          !!other.expect.company &&
          companyKey(other.expect.company) ===
            companyKey(email.expect.company ?? "") &&
          other.expect.title?.toLowerCase() ===
            email.expect.title?.toLowerCase(),
      );
      if (email.expect.kind === "CONFIRMATION_RECEIVED" && complete) continue; // checked per job above
      const allowed = !complete
        ? ["MISSING_JOB_DETAILS"]
        : confirmed
          ? ["APPLIED"]
          : ["NO_KNOWN_SUBMISSION"];
      assert.ok(
        allowed.includes(outcome ?? ""),
        `${email.id}: ${outcome}, expected ${allowed.join(" or ")}`,
      );
    }
  } finally {
    await t.close();
  }
});
