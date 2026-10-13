import assert from "node:assert/strict";
import { test } from "node:test";
import { admin } from "../scripts/vercel-operations.ts";
const config = {
  token: "synthetic",
  projectId: "prj_ledger",
  orgId: "team_ledger",
};
const google = {
  clientId: "synthetic.apps.googleusercontent.com",
  clientSecret: "synthetic-client-secret",
  allowedEmails: "owner@example.com",
};
function fixture(
  options: {
    preview?: boolean;
    productionInList?: boolean;
    wrongProject?: boolean;
    existing?: string[];
    shared?: boolean;
    latePromotion?: boolean;
  } = {},
) {
  const calls: { url: URL; init: RequestInit }[] = [],
    created: Record<string, unknown>[] = [];
  let deleted = false,
    projectReads = 0;
  const fetchFn = (async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/v9/projects/prj_ledger") {
      projectReads++;
      return Response.json({
        id: "prj_ledger",
        targets: {
          production: {
            id:
              options.latePromotion && projectReads > 1
                ? "dpl_preview"
                : "dpl_production",
          },
        },
      });
    }
    if (url.pathname === "/v6/deployments")
      return Response.json({
        deployments: options.productionInList
          ? [{ uid: "dpl_production" }]
          : options.preview && !deleted
            ? [{ uid: "dpl_preview" }]
            : [],
        pagination: { next: null },
      });
    if (url.pathname === "/v13/deployments/dpl_production")
      return Response.json({
        id: "dpl_production",
        projectId: "prj_ledger",
        target: "production",
      });
    if (url.pathname === "/v13/deployments/dpl_preview") {
      if (init.method === "DELETE") {
        deleted = true;
        return Response.json({ id: "dpl_preview" });
      }
      return Response.json({
        id: "dpl_preview",
        projectId: options.wrongProject ? "prj_other" : "prj_ledger",
        target: null,
      });
    }
    if (url.pathname === "/v9/projects/prj_ledger/env")
      return Response.json({
        envs: (options.existing ?? []).map((key) => ({
          key,
          target: options.shared ? ["production", "preview"] : ["production"],
        })),
      });
    if (url.pathname === "/v10/projects/prj_ledger/env") {
      created.push(JSON.parse(String(init.body)));
      return Response.json({ id: "env_synthetic" });
    }
    throw new Error("Unexpected fixture request");
  }) as typeof fetch;
  return { client: admin({ ...config, fetchFn }), calls, created };
}
test("preview inventory is read only; cleanup deletes only validated previews in the selected project", async () => {
  const f = fixture({ preview: true });
  assert.equal(await f.client.removePreviews(true), 1);
  assert.equal(
    f.calls.some((c) => c.init.method === "DELETE"),
    false,
  );
  assert.equal(await f.client.removePreviews(false), 1);
  assert.equal(f.calls.filter((c) => c.init.method === "DELETE").length, 1);
  for (const { url, init } of f.calls) {
    assert.equal(url.origin, "https://api.vercel.com");
    assert.equal(url.searchParams.get("teamId"), "team_ledger");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
  }
});
for (const options of [
  { productionInList: true },
  { preview: true, wrongProject: true },
  { preview: true, latePromotion: true },
])
  test(`preview cleanup refuses production, foreign projects, and concurrent promotion: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    await assert.rejects(f.client.removePreviews(false));
    assert.equal(
      f.calls.some((c) => c.init.method === "DELETE"),
      false,
    );
  });
test("Google provisioning is production-only, secrets are independent, and existing keys are preserved", async () => {
  const f = fixture();
  const keys = await f.client.configureGoogle(google);
  assert.equal(keys.length, 5);
  const signing = String(f.created.find((v) => v.key === "AUTH_SECRET")!.value),
    token = String(
      f.created.find((v) => v.key === "TOKEN_ENCRYPTION_KEY")!.value,
    );
  assert.equal(Buffer.from(signing, "base64").length, 32);
  assert.equal(Buffer.from(token, "base64").length, 32);
  assert.notEqual(signing, token);
  for (const variable of f.created) {
    assert.equal(variable.type, "sensitive");
    assert.deepEqual(variable.target, ["production"]);
  }
  const existing = fixture({
    existing: ["AUTH_SECRET", "TOKEN_ENCRYPTION_KEY"],
  });
  await existing.client.configureGoogle(google);
  assert.equal(
    existing.created.some(
      (v) => v.key === "AUTH_SECRET" || v.key === "TOKEN_ENCRYPTION_KEY",
    ),
    false,
  );
});
test("Google setup refuses surviving previews, shared keys, and partial OAuth client configuration", async () => {
  for (const options of [
    { preview: true },
    { existing: ["AUTH_SECRET"], shared: true },
    { existing: ["GOOGLE_CLIENT_ID"] },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.client.configureGoogle(google));
    assert.equal(f.created.length, 0);
  }
});
test("Google setup validates client and allowlist before making provider requests", async () => {
  for (const input of [
    { ...google, clientId: "wrong" },
    { ...google, allowedEmails: "" },
    { ...google, allowedEmails: "not-an-email" },
  ]) {
    const f = fixture();
    await assert.rejects(f.client.configureGoogle(input));
    assert.equal(f.calls.length, 0);
  }
});

test("Vercel personal accounts do not send a user ID as a team selector", async () => {
  let selected: URL | undefined;
  const client = admin({
    ...config,
    orgId: "user_ledger",
    fetchFn: (async (url) => {
      selected = new URL(String(url));
      return Response.json({
        id: "prj_ledger",
        targets: { production: { id: "dpl_production" } },
      });
    }) as typeof fetch,
  });
  await assert.rejects(client.removePreviews(true));
  assert.equal(selected!.searchParams.has("teamId"), false);
});
