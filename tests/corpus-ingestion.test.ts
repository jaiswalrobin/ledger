import assert from "node:assert/strict";
import { it } from "node:test";
import { CORPUS } from "./corpus/emails.ts";
import { FakeGmail } from "./helpers/fake-gmail.ts";
import { createTestDb, seedMailbox, seedUser } from "./helpers/db.ts";
import { syncMailbox } from "../src/server/gmail/sync.ts";

it("every positive corpus message survives discovery, header screening, and database ingestion", async () => {
  const t = await createTestDb();
  try {
    const userId = await seedUser(t.db);
    const mailboxId = await seedMailbox(t.db, userId);
    const gmail = new FakeGmail();
    gmail.strictDiscovery = true;
    gmail.pageSize = 100;
    const positives = CORPUS.filter(email => email.expect.kind !== null);
    for (const email of positives) gmail.add(email.id, {
      ...email, to: "applicant@example.com", date: "Mon, 12 Oct 2026 09:30:00 +0000",
      messageId: `<${email.id}@corpus.example>`,
    });
    const deps = { db: t.db, clientFor: async () => gmail, now: () => new Date("2026-10-20T12:00:00Z"), budgetMs: 60_000 };
    await syncMailbox(deps, mailboxId, { userId });
    await syncMailbox(deps, mailboxId, { userId });
    const tasks = await t.db.query<{ provider_message_id: string; outcome: string }>(
      "SELECT provider_message_id,outcome FROM processing_tasks WHERE mailbox_id=$1", [mailboxId],
    );
    const outcomes = new Map(tasks.rows.map(row => [row.provider_message_id, row.outcome]));
    for (const email of positives) {
      assert.equal(outcomes.get(email.id), "PROCESSED", email.id);
      assert.ok(gmail.calls.raw.includes(email.id), `${email.id}: body never fetched`);
    }
  } finally { await t.close(); }
});
