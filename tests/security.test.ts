import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { ConfigError, parseConfig } from "../src/server/config.ts";
import { isAllowed, upsertLoginUser } from "../src/server/auth.ts";
import { decryptToken, encryptToken } from "../src/server/gmail/vault.ts";
import {
  OAuthError,
  buildAuthUrl,
  exchangeCode,
  parseIdToken,
  pkcePair,
  refreshAccessToken,
} from "../src/server/security/oauth.ts";
import { signToken, verifyToken } from "../src/server/security/tokens.ts";
import type { Db } from "../src/server/db.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";

const key = randomBytes(32);
const secret = randomBytes(32);
const NOW = new Date("2026-10-13T12:00:00Z");

describe("refresh-token vault", () => {
  it("round-trips and never reuses an IV", () => {
    const a = encryptToken(key, "1//refresh-token", "mailbox-1");
    const b = encryptToken(key, "1//refresh-token", "mailbox-1");
    assert.equal(decryptToken(key, a, "mailbox-1"), "1//refresh-token");
    assert.notDeepEqual(a, b);
    assert.equal(a[0], 1, "first byte records the key version for rotation");
    assert.equal(
      a.includes(Buffer.from("1//refresh-token")),
      false,
      "no plaintext in the blob",
    );
  });
  it("refuses a different key, tampering, or a ciphertext moved to another mailbox row", () => {
    const blob = encryptToken(key, "tok", "mailbox-1");
    assert.throws(() => decryptToken(randomBytes(32), blob, "mailbox-1"));
    assert.throws(() => decryptToken(key, blob, "mailbox-2"));
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    assert.throws(() => decryptToken(key, tampered, "mailbox-1"));
  });
});

describe("signed tokens", () => {
  it("verify only for their own purpose, secret and lifetime", () => {
    const token = signToken(secret, "session", { uid: "u1" }, NOW, 60);
    assert.deepEqual(
      verifyToken<{ uid: string }>(secret, "session", token, NOW),
      { uid: "u1" },
    );
    assert.equal(
      verifyToken(secret, "oauth", token, NOW),
      null,
      "purpose is domain-separated",
    );
    assert.equal(verifyToken(randomBytes(32), "session", token, NOW), null);
    assert.equal(
      verifyToken(secret, "session", token, new Date(NOW.getTime() + 61_000)),
      null,
      "expired",
    );
  });
  it("reject any modification of payload or signature", () => {
    const token = signToken(secret, "session", { uid: "u1" }, NOW, 60);
    const [payload, sig] = token.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({
        d: { uid: "u2" },
        exp: Math.floor(NOW.getTime() / 1000) + 60,
      }),
    ).toString("base64url");
    assert.equal(verifyToken(secret, "session", `${forged}.${sig}`, NOW), null);
    assert.equal(
      verifyToken(
        secret,
        "session",
        `${payload}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`,
        NOW,
      ),
      null,
    );
    assert.equal(verifyToken(secret, "session", "garbage", NOW), null);
    assert.equal(verifyToken(secret, "session", "", NOW), null);
  });
});

describe("oauth helpers", () => {
  it("PKCE challenge is the S256 of the verifier", () => {
    const { verifier, challenge } = pkcePair();
    assert.equal(
      challenge,
      createHash("sha256").update(verifier).digest("base64url"),
    );
    assert.ok(verifier.length >= 43);
  });

  it("builds an auth URL with state, nonce and PKCE; offline access only when asked", () => {
    const base = {
      clientId: "cid",
      redirectUri: "https://app.example/cb",
      state: "s",
      nonce: "n",
      challenge: "c",
    };
    const login = new URL(
      buildAuthUrl({ ...base, scope: "openid email", offline: false }),
    );
    assert.equal(login.searchParams.get("code_challenge_method"), "S256");
    assert.equal(login.searchParams.get("state"), "s");
    assert.equal(login.searchParams.get("nonce"), "n");
    assert.equal(login.searchParams.get("access_type"), null);
    const gmail = new URL(
      buildAuthUrl({
        ...base,
        scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
        offline: true,
      }),
    );
    assert.equal(gmail.searchParams.get("access_type"), "offline");
    assert.equal(gmail.searchParams.get("prompt"), "consent");
    assert.equal(
      gmail.searchParams.get("include_granted_scopes"),
      null,
      "never widen the grant",
    );
  });

  const idToken = (claims: Record<string, unknown>) =>
    `h.${Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: "cid", sub: "123", email: "me@example.com", email_verified: true, nonce: "n", exp: Math.floor(NOW.getTime() / 1000) + 600, ...claims })).toString("base64url")}.s`;
  const expected = { clientId: "cid", nonce: "n", now: NOW };

  it("accepts a valid ID token and exposes only sub/email", () => {
    assert.deepEqual(parseIdToken(idToken({}), expected), {
      sub: "123",
      email: "me@example.com",
    });
  });
  it("rejects wrong audience, issuer, nonce, expiry and unverified email", () => {
    for (const claims of [
      { aud: "other" },
      { iss: "https://evil.example" },
      { nonce: "x" },
      { exp: 1 },
      { email_verified: false },
      { sub: "" },
    ]) {
      assert.throws(
        () => parseIdToken(idToken(claims), expected),
        OAuthError,
        JSON.stringify(claims),
      );
    }
    assert.throws(() => parseIdToken("not-a-jwt", expected), OAuthError);
  });

  it("exchanges a code with the verifier and returns tokens", async () => {
    let seen: { url: string; body: URLSearchParams } | undefined;
    const fetchFn = (async (url: string, init: { body: URLSearchParams }) => {
      seen = { url, body: init.body };
      return Response.json({
        access_token: "at",
        refresh_token: "rt",
        id_token: "idt",
        scope: "openid email",
        expires_in: 3599,
      });
    }) as unknown as typeof fetch;
    const out = await exchangeCode({
      fetchFn,
      clientId: "cid",
      clientSecret: "sec",
      code: "code1",
      verifier: "ver",
      redirectUri: "https://app.example/cb",
    });
    assert.deepEqual(out, {
      accessToken: "at",
      refreshToken: "rt",
      idToken: "idt",
      scope: "openid email",
    });
    assert.equal(seen!.body.get("grant_type"), "authorization_code");
    assert.equal(seen!.body.get("code_verifier"), "ver");
  });

  it("surfaces Google errors as codes, never echoing the response body", async () => {
    const fetchFn = (async () =>
      Response.json(
        {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked. secret-detail",
        },
        { status: 400 },
      )) as unknown as typeof fetch;
    await assert.rejects(
      refreshAccessToken({
        fetchFn,
        clientId: "c",
        clientSecret: "s",
        refreshToken: "r",
      }),
      (e: unknown) =>
        e instanceof OAuthError &&
        e.code === "invalid_grant" &&
        !String(e.message).includes("secret-detail"),
    );
  });
});

describe("login allowlist and users", () => {
  let t: TestDb;
  let db: Db;
  before(async () => {
    t = await createTestDb();
    db = t.db;
  });
  after(() => t.close());

  it("matches case-insensitively and rejects everyone else", () => {
    assert.equal(isAllowed("Me@Example.com", ["me@example.com"]), true);
    assert.equal(isAllowed("other@example.com", ["me@example.com"]), false);
    assert.equal(isAllowed("", ["me@example.com"]), false);
  });
  it("maps a Google subject to one stable Ledger user", async () => {
    const first = await upsertLoginUser(db, "sub-1", "me@example.com");
    const again = await upsertLoginUser(db, "sub-1", "me@example.com");
    const other = await upsertLoginUser(db, "sub-2", "you@example.com");
    assert.equal(first, again);
    assert.notEqual(first, other);
  });
});

describe("config", () => {
  const good = {
    DATABASE_URL: "postgres://x",
    APP_URL: "https://ledger.example.com/",
    AUTH_SECRET: randomBytes(32).toString("base64"),
    ALLOWED_EMAILS: "Me@Example.com, you@example.com",
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "sec",
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    CRON_SECRET: "x".repeat(32),
  };
  it("parses a complete environment and normalises it", () => {
    const c = parseConfig(good);
    assert.equal(c.appUrl, "https://ledger.example.com");
    assert.deepEqual(c.allowedEmails, ["me@example.com", "you@example.com"]);
  });
  it("names missing or weak variables without ever echoing their values", () => {
    try {
      parseConfig({
        ...good,
        AUTH_SECRET: "short",
        TOKEN_ENCRYPTION_KEY: "not-32-bytes",
        CRON_SECRET: "tiny",
        APP_URL: "http://evil.example.com",
        GOOGLE_CLIENT_SECRET: "",
      });
      assert.fail("should throw");
    } catch (e) {
      assert.ok(e instanceof ConfigError);
      assert.deepEqual([...e.names].sort(), [
        "APP_URL",
        "AUTH_SECRET",
        "CRON_SECRET",
        "GOOGLE_CLIENT_SECRET",
        "TOKEN_ENCRYPTION_KEY",
      ]);
      assert.doesNotMatch(e.message, /short|not-32-bytes|tiny|evil/);
    }
  });
  it("allows plain http only for localhost", () => {
    assert.equal(
      parseConfig({ ...good, APP_URL: "http://localhost:3000" }).appUrl,
      "http://localhost:3000",
    );
  });
});

describe("credential boundary", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  function sources(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === "node_modules" || name === ".next") return [];
      return statSync(path).isDirectory()
        ? sources(path)
        : /\.(ts|tsx)$/.test(name)
          ? [path]
          : [];
    });
  }
  it("only src/server/gmail/** may reference token decryption", () => {
    const offenders = [
      ...sources(join(root, "src")),
      ...sources(join(root, "app")),
    ]
      .map((f) => relative(root, f))
      .filter((f) => !f.startsWith("src/server/gmail/"))
      .filter((f) =>
        /decryptToken|gmail\/vault/.test(readFileSync(join(root, f), "utf8")),
      );
    assert.deepEqual(offenders, []);
  });
  it("nothing logs token-bearing objects: no console calls in src/server", () => {
    const offenders = sources(join(root, "src", "server"))
      .map((f) => relative(root, f))
      .filter((f) =>
        /console\.(log|error|warn|info|debug)/.test(
          readFileSync(join(root, f), "utf8"),
        ),
      );
    assert.deepEqual(offenders, []);
  });
});
