import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomBytes } from "node:crypto";
import { createTestDb, seedUser, type TestDb } from "./helpers/db.ts";
import {
  assertOrigin,
  createSession,
  readSession,
  logout,
  requestBytes,
  rateLimit,
  WebError,
} from "../src/server/security/web.ts";
import { createFlow, validateFlow } from "../src/server/security/flow.ts";
import { seedDemo, pruneDemos } from "../src/server/demo.ts";
import { listOpenings, listReviews } from "../src/server/queries.ts";

let t: TestDb;
before(async () => {
  t = await createTestDb();
});
after(() => t.close());
test("HTTP mutations reject missing and foreign Origin", () => {
  for (const headers of [{}, { origin: "https://evil.example" }])
    assert.throws(
      () =>
        assertOrigin(
          new Request("https://ledger.example/api/import", { headers }),
          "https://ledger.example",
        ),
      WebError,
    );
  assert.doesNotThrow(() =>
    assertOrigin(
      new Request("https://ledger.example/api/import", {
        headers: { origin: "https://ledger.example" },
      }),
      "https://ledger.example",
    ),
  );
});
test("session tokens are opaque, hashed in PostgreSQL, and revoked on logout", async () => {
  const owner = await seedUser(t.db),
    token = await createSession(t.db, owner, true);
  assert.equal((await readSession(t.db, token, []))!.userId, owner);
  const stored = await t.db.query<{ token_hash: string }>(
    "SELECT token_hash FROM browser_sessions WHERE user_id=$1",
    [owner],
  );
  assert.notEqual(stored.rows[0]!.token_hash, token);
  assert.equal(await readSession(t.db, "forged", []), null);
  await logout(t.db, token);
  assert.equal(await readSession(t.db, token, []), null);
});
test("expiry and a removed Google email allowlist entry invalidate sessions", async () => {
  const user = await seedUser(t.db);
  await t.db.query(
    "UPDATE ledger_users SET login_email='owner@example.com' WHERE id=$1",
    [user],
  );
  const token = await createSession(t.db, user, false);
  assert.ok(await readSession(t.db, token, ["owner@example.com"]));
  assert.equal(await readSession(t.db, token, []), null);
  await t.db.query(
    "UPDATE browser_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
    [user],
  );
  assert.equal(await readSession(t.db, token, ["owner@example.com"]), null);
});
test("OAuth state binds purpose, nonce, lifetime, and the initiating Gmail user", () => {
  const secret = randomBytes(32),
    now = new Date(),
    flow = createFlow(secret, "gmail", "owner", now);
  assert.equal(
    validateFlow(secret, flow.cookie, flow.flow.state, "gmail", "owner", now)
      .nonce,
    flow.flow.nonce,
  );
  for (const args of [
    [flow.flow.state, "gmail", "intruder"],
    ["wrong", "gmail", "owner"],
    [flow.flow.state, "login", null],
  ] as const)
    assert.throws(
      () => validateFlow(secret, flow.cookie, args[0], args[1], args[2], now),
      WebError,
    );
  assert.throws(
    () =>
      validateFlow(
        secret,
        flow.cookie,
        flow.flow.state,
        "gmail",
        "owner",
        new Date(now.getTime() + 601000),
      ),
    WebError,
  );
});
test("chunked bodies without Content-Length are capped before parsing", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(80));
      controller.enqueue(new Uint8Array(80));
      controller.close();
    },
  });
  const req = new Request("https://ledger.example/api/import", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);
  await assert.rejects(
    requestBytes(req, 100),
    (e) => e instanceof WebError && e.status === 413,
  );
});
test("abuse limits survive separate requests and clients", async () => {
  const key = randomBytes(8).toString("hex");
  await rateLimit(t.db, key, 2);
  await rateLimit(t.db, key, 2);
  await assert.rejects(
    rateLimit(t.db, key, 2),
    (e) => e instanceof WebError && e.status === 429,
  );
});
test("each demo workspace is persisted and isolated; deleting it cascades only its data", async () => {
  const a = await seedDemo(t.db),
    b = await seedDemo(t.db);
  assert.equal((await listOpenings(t.db, a)).length, 4);
  assert.equal((await listReviews(t.db, a)).length, 1);
  const token = await createSession(t.db, a, true);
  await t.db.query("DELETE FROM ledger_users WHERE id=$1", [a]);
  assert.equal(await readSession(t.db, token, []), null);
  assert.equal((await listOpenings(t.db, a)).length, 0);
  assert.equal((await listOpenings(t.db, b)).length, 4);
});
test("expired demo history is purged while current workspaces and Google accounts remain", async () => {
  const old = await seedDemo(t.db),
    active = await seedDemo(t.db),
    google = await seedUser(t.db);
  await t.db.query(
    "UPDATE demo_workspaces SET expires_at=now()-interval '1 day' WHERE user_id=$1",
    [old],
  );
  await t.db.query(
    "UPDATE ledger_users SET login_subject='retention-google' WHERE id=$1",
    [google],
  );
  assert.equal(await pruneDemos(t.db), 1);
  assert.equal((await listOpenings(t.db, old)).length, 0);
  assert.equal((await listOpenings(t.db, active)).length, 4);
  assert.equal(
    (await t.db.query("SELECT id FROM ledger_users WHERE id=$1", [google])).rows
      .length,
    1,
  );
});
