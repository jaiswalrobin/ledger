/**
 * Post-deploy smoke test. Exercises a RUNNING deployment over HTTP the way an outsider would:
 * security headers, authentication, CSRF/origin protection, the cron endpoint failing closed and
 * (when demo mode is on) a full round trip through the database. It prints results only, never
 * cookies, tokens or response bodies, and exits non-zero on the first sign of trouble.
 *
 *   BASE_URL=https://ledger.example.com node --experimental-strip-types scripts/smoke.ts
 *
 *   BASE_URL                  required. Origin of the deployment under test.
 *   ORIGIN                    origin sent with state-changing requests; must equal the app's
 *                             APP_URL. Defaults to BASE_URL.
 *   SMOKE_SIMULATE_FAILURE=1  run every real check, then fail on purpose. Used to prove that the
 *                             pipeline's rollback path works.
 *   SMOKE_READY_TIMEOUT_MS    how long to wait for the deployment to answer (default 90000).
 */
// A module (not a global script): top-level await needs it, and it keeps these names off the global scope.
export {};

/** Accept only a bare origin (scheme + host[:port]); anything else is a configuration mistake. */
function parseOrigin(name: string, value: string | undefined): string {
  try {
    const url = new URL(value ?? "");
    const bare =
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password;
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      bare &&
      !/\s/.test(value ?? "")
    )
      return url.origin;
  } catch {
    // reported below
  }
  console.error(
    `${name} must be an origin such as https://host (no path, query or spaces).`,
  );
  process.exit(2);
}
const base = parseOrigin("BASE_URL", process.env.BASE_URL);
const appOrigin = process.env.ORIGIN
  ? parseOrigin("ORIGIN", process.env.ORIGIN)
  : base;
const secure = base.startsWith("https:");
const readyTimeout = Number(process.env.SMOKE_READY_TIMEOUT_MS ?? 90_000);
const ZERO_UUID = "00000000-0000-4000-8000-000000000000";

interface Result {
  name: string;
  ok: boolean;
  note: string;
}
const results: Result[] = [];

async function call(
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(base + path, {
    method: init.method ?? "GET",
    headers: init.headers ?? {},
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
}

async function check(
  name: string,
  run: () => Promise<string | void>,
): Promise<boolean> {
  try {
    const note = (await run()) ?? "";
    results.push({ name, ok: true, note });
    console.log(`ok    ${name}${note ? "  — " + note : ""}`);
    return true;
  } catch (error) {
    const note = error instanceof Error ? error.message : "failed";
    results.push({ name, ok: false, note });
    console.log(`FAIL  ${name}  — ${note}`);
    return false;
  }
}

function expectStatus(res: Response, want: number, what: string): void {
  if (res.status !== want)
    throw new Error(`${what}: expected HTTP ${want}, got ${res.status}`);
}

/** The deployment may still be warming up (cold start, domain just switched). Wait, but not forever. */
async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + readyTimeout;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await call("/api/session");
      if (res.status === 200) return;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : "network error";
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`deployment never became ready (${last})`);
}

await check("deployment answers", waitUntilReady);

await check("page and security headers", async () => {
  const res = await call("/");
  expectStatus(res, 200, "GET /");
  const h = res.headers;
  const need: [string, (v: string) => boolean][] = [
    [
      "content-security-policy",
      (v) =>
        v.includes("default-src 'self'") &&
        v.includes("frame-ancestors 'none'"),
    ],
    ["x-frame-options", (v) => v.toUpperCase() === "DENY"],
    ["x-content-type-options", (v) => v.toLowerCase() === "nosniff"],
    ["referrer-policy", (v) => v.length > 0],
  ];
  if (secure)
    need.push(["strict-transport-security", (v) => /max-age=\d{7,}/.test(v)]);
  for (const [name, ok] of need) {
    const value = h.get(name);
    if (!value || !ok(value)) throw new Error(`missing or weak ${name}`);
  }
  if (h.get("x-powered-by"))
    throw new Error("x-powered-by leaks the framework");
});

let demoEnabled = false;
const sessionOk = await check("session endpoint", async () => {
  const res = await call("/api/session");
  expectStatus(res, 200, "GET /api/session");
  const body = (await res.json()) as {
    session: unknown;
    demoEnabled: unknown;
    googleReady: unknown;
  };
  if (body.session !== null)
    throw new Error("an anonymous caller received a session");
  if (
    typeof body.demoEnabled !== "boolean" ||
    typeof body.googleReady !== "boolean"
  )
    throw new Error("unexpected response shape");
  demoEnabled = body.demoEnabled;
  return `demo ${demoEnabled ? "on" : "off"}, google ${body.googleReady ? "on" : "off"}`;
});

await check("signed-out requests are refused", async () => {
  expectStatus(await call("/api/dashboard"), 401, "GET /api/dashboard");
  expectStatus(
    await call(`/api/openings/${ZERO_UUID}`),
    401,
    "GET /api/openings/<id>",
  );
});

await check("cron endpoint fails closed", async () => {
  const bare = await call("/api/cron/sync");
  // 503 is still a refusal, but it means the deployment has no CRON_SECRET: the scheduler could
  // never authenticate. A production deployment must answer 401.
  if (bare.status === 503)
    throw new Error("answers 503: CRON_SECRET is not set on this deployment");
  expectStatus(bare, 401, "no credential");
  expectStatus(
    await call("/api/cron/sync", {
      headers: { authorization: "Bearer not-the-secret" },
    }),
    401,
    "wrong bearer",
  );
  expectStatus(
    await call("/api/cron/sync", { method: "POST" }),
    401,
    "POST without credential",
  );
});

await check("cross-origin writes are refused", async () => {
  expectStatus(await call("/api/demo", { method: "POST" }), 403, "no Origin");
  expectStatus(
    await call("/api/demo", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    }),
    403,
    "foreign Origin",
  );
});

if (demoEnabled) {
  await check("demo workspace round trip through the database", async () => {
    const created = await call("/api/demo", {
      method: "POST",
      headers: { origin: appOrigin },
    });
    expectStatus(created, 200, `POST /api/demo with Origin ${appOrigin}`);
    const raw = created.headers
      .getSetCookie()
      .find((c) => c.startsWith("ledger_session="));
    if (!raw) throw new Error("no session cookie was issued");
    for (const flag of ["HttpOnly", "SameSite=lax"])
      if (!raw.includes(flag)) throw new Error(`session cookie lacks ${flag}`);
    if (secure && !raw.includes("Secure"))
      throw new Error("session cookie lacks Secure over HTTPS");
    const cookie = raw.split(";")[0]!;

    const dash = await call("/api/dashboard", { headers: { cookie } });
    expectStatus(dash, 200, "GET /api/dashboard with session");
    const data = (await dash.json()) as { openings: { attempts: unknown[] }[] };
    if (!Array.isArray(data.openings) || data.openings.length === 0)
      throw new Error(
        "the new workspace has no data (database read or write failed)",
      );

    expectStatus(
      await call("/api/logout", {
        method: "POST",
        headers: { origin: appOrigin, cookie },
      }),
      200,
      "POST /api/logout",
    );
    expectStatus(
      await call("/api/dashboard", { headers: { cookie } }),
      401,
      "session after logout",
    );
    return `${data.openings.length} openings read back; logout invalidated the session`;
  });
} else if (sessionOk) {
  results.push({
    name: "database round trip",
    ok: true,
    note: "skipped (demo mode off)",
  });
  console.log(
    "skip  database round trip  — demo mode is off, so no anonymous path touches the database",
  );
}

if (process.env.SMOKE_SIMULATE_FAILURE === "1") {
  await check("simulated failure (requested)", async () => {
    throw new Error("SMOKE_SIMULATE_FAILURE=1");
  });
}

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length
    ? `\n${failed.length} of ${results.length} checks failed.`
    : `\nAll ${results.length} checks passed.`,
);
process.exit(failed.length ? 1 : 0);
