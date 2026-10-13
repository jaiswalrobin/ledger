import assert from "node:assert/strict";
import { test } from "node:test";
import { checkVercelToken, describeVerdict } from "../scripts/vercel-token.ts";

const TOKEN = "synthetic-token-value";
const ORG = "team_ledger";

/** Answers each Vercel path with a fixed status and records what was requested. */
function fixture(statuses: Record<string, number | Error>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchFn = (async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const status = statuses[url.pathname];
    if (status === undefined) throw new Error(`unexpected path ${url.pathname}`);
    if (status instanceof Error) throw status;
    return new Response(JSON.stringify({ secret: "body-must-not-leak" }), {
      status,
    });
  }) as typeof fetch;
  return { calls, fetchFn };
}
const check = (statuses: Record<string, number | Error>) => {
  const f = fixture(statuses);
  return checkVercelToken({ token: TOKEN, orgId: ORG, fetchFn: f.fetchFn }).then(
    (result) => ({ result, calls: f.calls }),
  );
};

test("token check: a user token that can read the team is ok", async () => {
  const { result, calls } = await check({
    "/v2/user": 200,
    [`/v2/teams/${ORG}`]: 200,
  });
  assert.deepEqual(result, { verdict: "ok", userStatus: 200, teamStatus: 200 });
  assert.deepEqual(
    calls.map((c) => c.url.pathname),
    ["/v2/user", `/v2/teams/${ORG}`],
  );
});

test("token check: 403 from the user endpoint means the token itself is rejected", async () => {
  const { result, calls } = await check({ "/v2/user": 403 });
  assert.equal(result.verdict, "invalid-token");
  assert.equal(result.userStatus, 403);
  // Nothing more is asked of a token the API already rejected.
  assert.equal(calls.length, 1);
});

// The production incident: the REST API accepts the token, but /v2/user answers
// 404 "User not found", which makes the CLI's inspect, promote and rollback fail.
test("token check: 404 from the user endpoint means a valid token that is not a user token", async () => {
  const { result } = await check({ "/v2/user": 404 });
  assert.equal(result.verdict, "not-a-user-token");
  assert.equal(result.userStatus, 404);
  assert.equal(result.teamStatus, null);
});

for (const teamStatus of [403, 404])
  test(`token check: a user token that gets ${teamStatus} for the team has no team access`, async () => {
    const { result } = await check({
      "/v2/user": 200,
      [`/v2/teams/${ORG}`]: teamStatus,
    });
    assert.equal(result.verdict, "no-team-access");
    assert.equal(result.teamStatus, teamStatus);
  });

test("token check: server errors and network failures are reported as unexpected, not as a bad token", async () => {
  assert.equal((await check({ "/v2/user": 503 })).result.verdict, "unexpected");
  const offline = await check({ "/v2/user": new TypeError("fetch failed") });
  assert.equal(offline.result.verdict, "unexpected");
  assert.equal(offline.result.userStatus, null);
  const teamDown = await check({
    "/v2/user": 200,
    [`/v2/teams/${ORG}`]: 500,
  });
  assert.equal(teamDown.result.verdict, "unexpected");
});

test("token check: a personal owner id skips the team lookup", async () => {
  const f = fixture({ "/v2/user": 200 });
  const result = await checkVercelToken({
    token: TOKEN,
    orgId: "user_ledger",
    fetchFn: f.fetchFn,
  });
  assert.equal(result.verdict, "ok");
  assert.equal(f.calls.length, 1);
});

test("token check: the token only goes to api.vercel.com as a bearer header, never into a URL", async () => {
  const { calls } = await check({ "/v2/user": 200, [`/v2/teams/${ORG}`]: 200 });
  for (const { url, init } of calls) {
    assert.equal(url.origin, "https://api.vercel.com");
    assert.equal(url.href.includes(TOKEN), false);
    assert.equal(
      (init.headers as Record<string, string>).authorization,
      `Bearer ${TOKEN}`,
    );
    assert.equal(init.redirect, "error");
  }
});

test("token check: rejects an owner id that is neither a team nor a user", async () => {
  await assert.rejects(
    checkVercelToken({ token: TOKEN, orgId: "../v2/user", fetchFn: fetch }),
    /INVALID_VERCEL_OWNER/,
  );
});

test("token check: messages name the status, give a next step, and never contain the token or a response body", async () => {
  for (const verdict of [
    "ok",
    "invalid-token",
    "not-a-user-token",
    "no-team-access",
    "unexpected",
  ] as const) {
    const text = describeVerdict({ verdict, userStatus: 404, teamStatus: 403 });
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes("body-must-not-leak"), false);
  }
  const notUser = describeVerdict({
    verdict: "not-a-user-token",
    userStatus: 404,
    teamStatus: null,
  });
  assert.match(notUser, /404/);
  assert.match(notUser, /docs\/deployment\.md/);
  assert.match(
    describeVerdict({ verdict: "invalid-token", userStatus: 403, teamStatus: null }),
    /expired|revoked|invalid/i,
  );
});
