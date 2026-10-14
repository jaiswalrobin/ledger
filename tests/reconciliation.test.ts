import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEml } from "../src/ingestion/eml.ts";
import { ingestOriginal, drainReviewReconciliations } from "../src/server/pipeline.ts";
import { dismissReview } from "../src/server/actions.ts";
import { runScheduledSync } from "../src/server/scheduler.ts";
import { buildEml } from "./helpers/eml.ts";
import { createTestDb, seedMailbox, seedUser } from "./helpers/db.ts";

test("reconciliation scopes the opening, checkpoints a bounded batch, and continues past invalid dates", async () => {
  const t = await createTestDb();
  try {
    const user = await seedUser(t.db), mailbox = await seedMailbox(t.db, user);
    const now = new Date("2026-10-20T12:00:00Z");
    let serial = 0;
    const ingest = async (text: string, receipt = false) => {
      const id = ++serial;
      const [original] = await parseEml(new TextEncoder().encode(buildEml({
        from: "Acme <no-reply@us.greenhouse-mail.io>", to: "jobs@example.org",
        subject: receipt ? "Application received" : "Interview invitation",
        date: receipt ? "Mon, 05 Oct 2026 10:00:00 +0000" : "Mon, 12 Oct 2026 10:00:00 +0000",
        messageId: `<reconcile-${id}@example.org>`, text,
      })));
      return ingestOriginal(t.db, { userId: user, source: { kind: "GMAIL", mailboxId: mailbox,
        providerMessageId: `reconcile-${id}`, senderAuthenticated: true }, original: original!, observedAt: now });
    };
    const invitation = "Please schedule your interview for the Backend Engineer role at Acme.\nApplication ID: APP-11111";
    for (let i = 0; i < 32; i++) {
      const result = await ingest(invitation);
      assert.equal(result.status, "REVIEW");
      if (result.status !== "REVIEW") throw new Error("Expected a waiting review");
      await t.db.query("UPDATE review_items SET created_at=$2 WHERE id=$1",
        [result.reviewId, new Date(Date.UTC(2026, 9, 13, 0, 0, i)).toISOString()]);
      if (!i) await t.db.query(`UPDATE source_artifacts SET original_message_at='2099-01-01T00:00:00Z'
        WHERE id=(SELECT source_artifact_id FROM review_items WHERE id=$1)`, [result.reviewId]);
    }
    const unrelated = await ingest("Please schedule your interview for the Finance Analyst role at OtherCo.");
    assert.equal(unrelated.status, "REVIEW");
    const dismissed = await ingest(invitation);
    if (dismissed.status !== "REVIEW") throw new Error("Expected a waiting review");
    await dismissReview(t.db, user, dismissed.reviewId);
    const receipt = await ingest("We received your application for the Backend Engineer role at Acme.\nApplication ID: APP-11111", true);
    assert.equal(receipt.status, "APPLIED");
    if (receipt.status !== "APPLIED") throw new Error("Expected a receipt");
    assert.equal(receipt.reconciled, 24, "at most 25 reviews are inspected in the ingestion transaction");
    assert.equal((await t.db.query("SELECT 1 FROM review_reconciliation_jobs WHERE user_id=$1", [user])).rows.length, 1);
    const continued = await runScheduledSync({ db: t.db, sync: null });
    assert.equal(continued.gmailConfigured, false);
    assert.equal(continued.reviewUpdatesApplied, 7, "scheduled continuation also works without a Gmail grant");
    assert.equal(continued.reconciliationFailed, false);
    assert.equal((await t.db.query("SELECT 1 FROM review_reconciliation_jobs WHERE user_id=$1", [user])).rows.length, 0);
    const open = await t.db.query("SELECT id FROM review_items WHERE user_id=$1 AND state='OPEN'", [user]);
    assert.equal(open.rows.length, 2, "invalid-date and unrelated-opening reviews remain for the owner");
    assert.equal((await t.db.query<{ state: string }>("SELECT state FROM review_items WHERE id=$1", [dismissed.reviewId])).rows[0]!.state, "DISMISSED");
    assert.deepEqual(await drainReviewReconciliations(t.db, now, 1), { applied: 0, failed: 0 });
  } finally { await t.close(); }
});
