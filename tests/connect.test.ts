import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { parseEml } from "../src/ingestion/eml.ts";
import { connectMailbox, disconnectMailbox, gmailClientFactory, grantedScopesAreReadOnly, MailboxNotFound } from "../src/server/gmail/connect.ts";
import { decryptToken } from "../src/server/gmail/vault.ts";
import { OAuthError } from "../src/server/security/oauth.ts";
import { ingestOriginal } from "../src/server/pipeline.ts";
import type { Db } from "../src/server/db.ts";
import { buildEml } from "./helpers/eml.ts";
import { createTestDb, seedUser, type TestDb } from "./helpers/db.ts";
import { greenhouseConfirmation } from "./helpers/fixtures.ts";

let t: TestDb;
let db: Db;
before(async () => { t = await createTestDb(); db = t.db; });
after(() => t.close());

const key = randomBytes(32);
const row = async (id: string) =>
  (await db.query<{ encrypted_refresh_token: Buffer | null; sync_state: string; history_cursor: string | null; last_error_code: string | null; disconnected_at: unknown; address: string }>(
    "SELECT encrypted_refresh_token, sync_state, history_cursor, last_error_code, disconnected_at, address FROM connected_mailboxes WHERE id = $1", [id])).rows[0]!;

describe("connectMailbox", () => {
  it("stores the refresh token encrypted and bound to its row, never in plaintext", async () => {
    const u = await seedUser(db);
    const { mailboxId, reconnected } = await connectMailbox(db, key, u, { sub: "g-1", email: "Jobs@Example.org" }, "1//plain-refresh-token");
    assert.equal(reconnected, false);
    const r = await row(mailboxId);
    assert.equal(r.sync_state, "INITIALIZING");
    assert.equal(r.address, "jobs@example.org");
    assert.equal(r.encrypted_refresh_token!.includes(Buffer.from("plain-refresh-token")), false);
    assert.equal(decryptToken(key, Buffer.from(r.encrypted_refresh_token!), mailboxId), "1//plain-refresh-token");
    assert.throws(() => decryptToken(key, Buffer.from(r.encrypted_refresh_token!), "another-row"));
  });

  it("reconnecting the same Google account reuses the row, clears errors and schedules a resync over the gap", async () => {
    const u = await seedUser(db);
    const first = await connectMailbox(db, key, u, { sub: "g-2", email: "a@example.org" }, "tok-1");
    await db.query("UPDATE connected_mailboxes SET sync_state = 'DEGRADED', last_error_code = 'TOKEN_REVOKED', history_cursor = '4242' WHERE id = $1", [first.mailboxId]);
    const second = await connectMailbox(db, key, u, { sub: "g-2", email: "a@example.org" }, "tok-2");
    assert.equal(second.mailboxId, first.mailboxId);
    assert.equal(second.reconnected, true);
    const r = await row(first.mailboxId);
    assert.equal(r.sync_state, "RESYNC_REQUIRED");
    assert.equal(r.last_error_code, null);
    assert.equal(decryptToken(key, Buffer.from(r.encrypted_refresh_token!), first.mailboxId), "tok-2");
  });

  it("allows the same Google account for two different Ledger users independently", async () => {
    const a = await seedUser(db);
    const b = await seedUser(db);
    const one = await connectMailbox(db, key, a, { sub: "shared", email: "x@example.org" }, "ta");
    const two = await connectMailbox(db, key, b, { sub: "shared", email: "x@example.org" }, "tb");
    assert.notEqual(one.mailboxId, two.mailboxId);
  });
});

describe("grantedScopesAreReadOnly", () => {
  it("accepts read-only Gmail plus identity scopes", () => {
    assert.equal(grantedScopesAreReadOnly("openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly"), true);
    assert.equal(grantedScopesAreReadOnly("openid email https://www.googleapis.com/auth/gmail.readonly"), true);
  });
  it("rejects anything that could modify or send, or a grant without Gmail read", () => {
    assert.equal(grantedScopesAreReadOnly("openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify"), false);
    assert.equal(grantedScopesAreReadOnly("openid email https://www.googleapis.com/auth/gmail.send"), false);
    assert.equal(grantedScopesAreReadOnly("https://mail.google.com/"), false);
    assert.equal(grantedScopesAreReadOnly("openid email"), false);
  });
});

describe("disconnectMailbox", () => {
  it("revokes at Google, wipes the token, fails pending work, and keeps accepted history", async () => {
    const u = await seedUser(db);
    const { mailboxId } = await connectMailbox(db, key, u, { sub: "g-3", email: "d@example.org" }, "tok-revoke-me");
    const [original] = await parseEml(new TextEncoder().encode(buildEml(greenhouseConfirmation())));
    await ingestOriginal(db, { userId: u, source: { kind: "GMAIL", mailboxId, providerMessageId: "g1" }, original: original! });
    await db.query("INSERT INTO processing_tasks (id, user_id, mailbox_id, provider_message_id) VALUES (gen_random_uuid(), $1, $2, 'pending-1')", [u, mailboxId]);

    let revoked: string | null = null;
    const fetchFn = (async (_url: string, init: { body: URLSearchParams }) => { revoked = init.body.get("token"); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const result = await disconnectMailbox(db, key, u, mailboxId, fetchFn);
    assert.equal(result.revoked, true);
    assert.equal(revoked, "tok-revoke-me");

    const r = await row(mailboxId);
    assert.equal(r.encrypted_refresh_token, null);
    assert.equal(r.sync_state, "DISCONNECTED");
    assert.ok(r.disconnected_at);
    const task = (await db.query<{ state: string }>("SELECT state FROM processing_tasks WHERE provider_message_id = 'pending-1'")).rows[0]!;
    assert.equal(task.state, "FAILED");
    assert.equal((await db.query("SELECT 1 FROM application_attempts WHERE user_id = $1", [u])).rows.length, 1, "history is preserved");
  });

  it("still disconnects locally when Google cannot be reached", async () => {
    const u = await seedUser(db);
    const { mailboxId } = await connectMailbox(db, key, u, { sub: "g-4", email: "e@example.org" }, "tok");
    const fetchFn = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const result = await disconnectMailbox(db, key, u, mailboxId, fetchFn);
    assert.equal(result.revoked, false);
    assert.equal((await row(mailboxId)).sync_state, "DISCONNECTED");
  });

  it("cannot disconnect another user's mailbox", async () => {
    const owner = await seedUser(db);
    const intruder = await seedUser(db);
    const { mailboxId } = await connectMailbox(db, key, owner, { sub: "g-5", email: "f@example.org" }, "tok");
    await assert.rejects(disconnectMailbox(db, key, intruder, mailboxId), MailboxNotFound);
    assert.equal((await row(mailboxId)).sync_state, "INITIALIZING");
  });
});

describe("gmailClientFactory", () => {
  it("exchanges the stored refresh token for an access token and returns a client", async () => {
    const u = await seedUser(db);
    const { mailboxId } = await connectMailbox(db, key, u, { sub: "g-6", email: "g@example.org" }, "refresh-6");
    let seenRefresh: string | null = null;
    let seenAuth: string | null = null;
    const fetchFn = (async (url: string | URL, init?: { body?: URLSearchParams; headers?: Record<string, string> }) => {
      if (String(url).includes("oauth2.googleapis.com/token")) { seenRefresh = init!.body!.get("refresh_token"); return Response.json({ access_token: "access-6" }); }
      seenAuth = init?.headers?.["authorization"] ?? null;
      return Response.json({ emailAddress: "g@example.org", historyId: "77" });
    }) as unknown as typeof fetch;
    const client = await gmailClientFactory(db, { tokenKey: key, clientId: "cid", clientSecret: "sec" }, fetchFn)({ id: mailboxId, userId: u, address: "g@example.org" });
    assert.equal(seenRefresh, "refresh-6");
    assert.deepEqual(await client.getProfile(), { emailAddress: "g@example.org", historyId: "77" });
    assert.equal(seenAuth, "Bearer access-6");
  });

  it("propagates a revoked grant as an OAuthError so the sync engine can degrade the mailbox", async () => {
    const u = await seedUser(db);
    const { mailboxId } = await connectMailbox(db, key, u, { sub: "g-7", email: "h@example.org" }, "refresh-7");
    const fetchFn = (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as unknown as typeof fetch;
    await assert.rejects(
      gmailClientFactory(db, { tokenKey: key, clientId: "c", clientSecret: "s" }, fetchFn)({ id: mailboxId, userId: u, address: "h@example.org" }),
      (e: unknown) => e instanceof OAuthError && e.code === "invalid_grant");
  });
});
