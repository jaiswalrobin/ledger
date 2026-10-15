import assert from "node:assert/strict";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { fromPglite } from "../src/server/db.ts";
import { applyMigrations } from "../src/server/migrate.ts";
import { insertOpening, insertAttempt } from "../src/server/store.ts";
import { seedUser, seedMailbox, MIGRATIONS_DIR } from "./helpers/db.ts";

it("calendar upgrades retain exact accepted proposals and leave ambiguous legacy evidence unassigned", async () => {
  const pg = new PGlite(),
    db = fromPglite(pg),
    directory = await mkdtemp(join(tmpdir(), "ledger-calendar-upgrade-"));
  try {
    for (const file of await readdir(MIGRATIONS_DIR))
      if (file.endsWith(".sql") && file < "0010")
        await copyFile(join(MIGRATIONS_DIR, file), join(directory, file));
    await applyMigrations(db, directory);
    const user = await seedUser(db),
      mailbox = await seedMailbox(db, user);
    const opening = await insertOpening(db, user, {
      company: "Acme",
      title: "Engineer",
      location: null,
      atsKey: null,
      canonicalUrl: null,
    });
    const attempt = await insertAttempt(db, user, opening, {
      applicantEmail: null,
      externalApplicationId: null,
      submittedAt: null,
      evidenceKey: "receipt",
    });
    const seed = async (ambiguous: boolean) => {
      const artifact = randomUUID(),
        event = randomUUID(),
        accepted = randomUUID();
      await db.query(
        "INSERT INTO source_artifacts(id,user_id,source_kind,mailbox_id,provider_message_id,source_fingerprint)VALUES($1::uuid,$2,'GMAIL',$3,$1::text,$1::text)",
        [artifact, user, mailbox],
      );
      const facts = {
        calendar: {
          uidKey: "a".repeat(64),
          sequence: 7,
          method: "REQUEST",
          status: "",
          scheduledFor: "2026-10-21T10:00:00.000Z",
          organizerDomain: "acme.example",
        },
      };
      for (const [id, version, state] of [
        [accepted, "old-accepted", "APPLIED"],
        [randomUUID(), "other-version", ambiguous ? "APPLIED" : "DISMISSED"],
      ])
        await db.query(
          "INSERT INTO extracted_signals(id,user_id,source_artifact_id,extractor_version,event_kind,fields,confidence,processing_state)VALUES($1,$2,$3,$4,'INTERVIEW_SCHEDULED',$5::jsonb,'HIGH',$6)",
          [id, user, artifact, version, JSON.stringify(facts), state],
        );
      await db.query(
        "INSERT INTO application_events(id,user_id,attempt_id,event_kind,occurred_at,review_state,source_type,dedupe_key)VALUES($1::uuid,$2,$3,'INTERVIEW_SCHEDULED','2026-10-12T10:00:00Z','ACCEPTED','GMAIL',$1::text)",
        [event, user, attempt],
      );
      await db.query(
        "INSERT INTO event_evidence(user_id,event_id,artifact_id,evidence_kind)VALUES($1,$2,$3,'SOURCE_EMAIL')",
        [user, event, artifact],
      );
      return { artifact, event, accepted };
    };
    const known = await seed(false),
      unknown = await seed(true);
    await applyMigrations(db, MIGRATIONS_DIR);
    const row = (
      await db.query<{
        signal_id: string;
        calendar_sequence: string;
        scheduled_for: unknown;
      }>(
        "SELECT ev.signal_id,e.calendar_sequence,e.scheduled_for FROM event_evidence ev JOIN application_events e ON e.id=ev.event_id WHERE e.id=$1",
        [known.event],
      )
    ).rows[0]!;
    assert.equal(row.signal_id, known.accepted);
    assert.equal(Number(row.calendar_sequence), 7);
    assert.equal(
      new Date(row.scheduled_for as string).toISOString(),
      "2026-10-21T10:00:00.000Z",
    );
    assert.equal(
      (
        await db.query(
          "SELECT signal_id FROM event_evidence WHERE event_id=$1",
          [unknown.event],
        )
      ).rows[0]!.signal_id,
      null,
    );
    assert.equal(
      (
        await db.query(
          "SELECT calendar_uid_key FROM application_events WHERE id=$1",
          [unknown.event],
        )
      ).rows[0]!.calendar_uid_key,
      null,
    );
    await assert.rejects(
      db.query("UPDATE event_evidence SET signal_id=$2 WHERE event_id=$1", [
        unknown.event,
        known.accepted,
      ]),
      (error) => (error as { code: string }).code === "23503",
    );
  } finally {
    await pg.close();
    await rm(directory, { recursive: true, force: true });
  }
});
