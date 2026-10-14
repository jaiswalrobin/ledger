import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  demoEnabled,
  googleReady,
  googleConfig,
  runtimeDb,
  siteOrigin,
} from "../../../src/server/runtime.ts";
import {
  COOKIE,
  WebError,
  assertOrigin,
  createSession,
  readSession,
  logout,
  rateLimit,
  requestBytes,
  requestJson,
  safeText,
  secureEqual,
  validUuid,
} from "../../../src/server/security/web.ts";
import type { BrowserSession } from "../../../src/server/security/web.ts";
import { createFlow, validateFlow } from "../../../src/server/security/flow.ts";
import {
  buildAuthUrl,
  exchangeCode,
  parseIdToken,
  OAuthError,
} from "../../../src/server/security/oauth.ts";
import { isAllowed, upsertLoginUser } from "../../../src/server/auth.ts";
import {
  connectMailbox,
  disconnectMailbox,
  gmailClientFactory,
  grantedScopesAreReadOnly,
} from "../../../src/server/gmail/connect.ts";
import {
  syncAllMailboxes,
  syncMailbox,
} from "../../../src/server/gmail/sync.ts";
import { requestMailboxRecheck } from "../../../src/server/gmail/recheck.ts";
import { runScheduledSync } from "../../../src/server/scheduler.ts";
import {
  listOpenings,
  getOpening,
  listReviews,
  listMailboxes,
} from "../../../src/server/queries.ts";
import {
  ActionError,
  dismissReview,
  resolveReviewAssign,
  resolveReviewCreate,
  setAttemptStatus,
  setEventState,
  correctSubmissionDate,
} from "../../../src/server/actions.ts";
import type { CreateInput } from "../../../src/server/actions.ts";
import type { Outcome, Stage } from "../../../src/domain/types.ts";
import { parseEml, EmlError } from "../../../src/ingestion/eml.ts";
import { ingestOriginal } from "../../../src/server/pipeline.ts";
import { sampleEmail, seedDemo, pruneDemos } from "../../../src/server/demo.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const FLOW_COOKIE = "ledger_oauth";
type Context = { params: Promise<{ segments: string[] }> };
const response = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
function allowed(): string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}
async function current(req: NextRequest): Promise<BrowserSession | null> {
  const token = req.cookies.get(COOKIE)?.value;
  if (!token) return null;
  const found = await readSession(runtimeDb(), token, allowed());
  return found?.isDemo && !demoEnabled() ? null : found;
}
async function requireSession(req: NextRequest): Promise<BrowserSession> {
  const found = await current(req);
  if (!found) throw new WebError("SIGN_IN_REQUIRED", 401);
  return found;
}
function cookieOptions() {
  return {
    httpOnly: true,
    secure: siteOrigin().startsWith("https:"),
    sameSite: "lax" as const,
    path: "/",
    maxAge: 7 * 86400,
  };
}
function setSession(out: NextResponse, token: string): NextResponse {
  out.cookies.set(COOKIE, token, cookieOptions());
  return out;
}
function ipKey(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}
function fail(error: unknown): NextResponse {
  if (error instanceof WebError)
    return response({ error: error.message }, error.status);
  if (error instanceof EmlError)
    return response({ error: `EMAIL_${error.code}` }, 400);
  if (error instanceof ActionError) return response({ error: error.code }, 400);
  if (error instanceof OAuthError)
    return response({ error: "GOOGLE_AUTH_FAILED" }, 400);
  return response({ error: "SERVICE_UNAVAILABLE" }, 503);
}
function oauthStart(
  purpose: "login" | "gmail",
  userId: string | null,
): NextResponse {
  const cfg = googleConfig();
  const created = createFlow(cfg.authSecret, purpose, userId);
  const target = buildAuthUrl({
    clientId: cfg.googleClientId,
    redirectUri: `${cfg.appUrl}/api/oauth/callback/${purpose}`,
    scope:
      purpose === "login"
        ? "openid email"
        : "openid email https://www.googleapis.com/auth/gmail.readonly",
    state: created.flow.state,
    nonce: created.flow.nonce,
    challenge: created.challenge,
    offline: purpose === "gmail",
  });
  const out =
    purpose === "login"
      ? NextResponse.redirect(target)
      : response({ url: target });
  out.cookies.set(FLOW_COOKIE, created.cookie, {
    ...cookieOptions(),
    path: "/api/oauth",
    maxAge: 600,
  });
  return out;
}
async function callback(
  req: NextRequest,
  purpose: "login" | "gmail",
): Promise<NextResponse> {
  const cfg = googleConfig();
  const session = purpose === "gmail" ? await requireSession(req) : null;
  if (session?.isDemo) throw new WebError("DEMO_ONLY", 403);
  const flow = validateFlow(
    cfg.authSecret,
    req.cookies.get(FLOW_COOKIE)?.value ?? "",
    req.nextUrl.searchParams.get("state") ?? "",
    purpose,
    session?.userId ?? null,
  );
  const code = req.nextUrl.searchParams.get("code");
  if (!code || code.length > 4096) throw new WebError("GOOGLE_AUTH_FAILED");
  const token = await exchangeCode({
    clientId: cfg.googleClientId,
    clientSecret: cfg.googleClientSecret,
    code,
    verifier: flow.verifier,
    redirectUri: `${cfg.appUrl}/api/oauth/callback/${purpose}`,
  });
  // ID tokens are accepted only from the pinned TLS token endpoint, never from the client.
  const identity = parseIdToken(token.idToken, {
    clientId: cfg.googleClientId,
    nonce: flow.nonce,
    now: new Date(),
  });
  const out = NextResponse.redirect(`${cfg.appUrl}/`);
  if (purpose === "login") {
    if (!isAllowed(identity.email, cfg.allowedEmails))
      throw new WebError("ACCOUNT_NOT_ALLOWED", 403);
    const userId = await upsertLoginUser(
      runtimeDb(),
      identity.sub,
      identity.email,
    );
    const next = await createSession(runtimeDb(), userId, false);
    await logout(runtimeDb(), req.cookies.get(COOKIE)?.value);
    setSession(out, next);
  } else {
    if (!grantedScopesAreReadOnly(token.scope) || !token.refreshToken)
      throw new WebError("READ_ONLY_GRANT_REQUIRED");
    await connectMailbox(
      runtimeDb(),
      cfg.tokenKey,
      session!.userId,
      identity,
      token.refreshToken,
    );
  }
  out.cookies.set(FLOW_COOKIE, "", {
    ...cookieOptions(),
    path: "/api/oauth",
    maxAge: 0,
  });
  return out;
}
async function cron(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 24)
    throw new WebError("SERVICE_UNAVAILABLE", 503);
  if (!secureEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`))
    throw new WebError("NOT_AUTHORIZED", 401);
  const db = runtimeDb();
  const cfg = googleReady() ? googleConfig() : null;
  // Counts only: the scheduler prints this report in CI logs.
  return response(
    await runScheduledSync({
      db,
      sync: cfg
        ? {
            clientFor: gmailClientFactory(db, {
              tokenKey: cfg.tokenKey,
              clientId: cfg.googleClientId,
              clientSecret: cfg.googleClientSecret,
            }),
            budgetMs: 240000,
          }
        : null,
    }),
  );
}

export async function GET(
  req: NextRequest,
  ctx: Context,
): Promise<NextResponse> {
  const path = (await ctx.params).segments.join("/");
  try {
    if (path === "session")
      return response({
        session: await current(req),
        demoEnabled: demoEnabled(),
        googleReady: googleReady(),
      });
    if (path === "sample")
      return new NextResponse(sampleEmail(), {
        headers: {
          "Content-Type": "message/rfc822",
          "Content-Disposition": 'attachment; filename="ledger-sample.eml"',
          "Cache-Control": "no-store",
        },
      });
    if (path === "oauth/login") {
      await rateLimit(runtimeDb(), `oauth:${ipKey(req)}`, 15);
      return oauthStart("login", null);
    }
    if (path === "oauth/callback/login" || path === "oauth/callback/gmail")
      return await callback(req, path.endsWith("gmail") ? "gmail" : "login");
    if (path === "cron/sync") return await cron(req);
    const session = await requireSession(req),
      db = runtimeDb();
    if (path === "dashboard")
      return response({
        openings: await listOpenings(db, session.userId),
        reviews: await listReviews(db, session.userId),
        mailboxes: await listMailboxes(db, session.userId),
      });
    if (path.startsWith("openings/")) {
      const opening = await getOpening(
        db,
        session.userId,
        validUuid(path.split("/")[1]),
      );
      if (!opening) throw new WebError("NOT_FOUND", 404);
      return response(opening);
    }
    return response({ error: "NOT_FOUND" }, 404);
  } catch (error) {
    if (path.startsWith("oauth/callback/")) {
      const out = NextResponse.redirect(`${siteOrigin()}/?authError=1`);
      out.cookies.set(FLOW_COOKIE, "", {
        ...cookieOptions(),
        path: "/api/oauth",
        maxAge: 0,
      });
      return out;
    }
    return fail(error);
  }
}

export async function POST(
  req: NextRequest,
  ctx: Context,
): Promise<NextResponse> {
  try {
    const path = (await ctx.params).segments.join("/");
    if (path === "cron/sync") return await cron(req);
    assertOrigin(req, siteOrigin());
    const db = runtimeDb();
    if (path === "demo") {
      if (!demoEnabled()) throw new WebError("DEMO_DISABLED", 403);
      await rateLimit(db, `demo:${ipKey(req)}`, 10);
      await rateLimit(db, "demo:global", 100);
      await pruneDemos(db);
      const userId = await seedDemo(db),
        token = await createSession(db, userId, true);
      await logout(db, req.cookies.get(COOKIE)?.value);
      return setSession(response({ ok: true }), token);
    }
    if (path === "logout") {
      await logout(db, req.cookies.get(COOKIE)?.value);
      const out = response({ ok: true });
      out.cookies.set(COOKIE, "", { ...cookieOptions(), maxAge: 0 });
      return out;
    }
    const session = await requireSession(req);
    await rateLimit(db, `write:${session.userId}`, 120);
    if (path === "import") {
      const bytes = await requestBytes(req, 3 * 1024 * 1024 + 65536);
      const form = await new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: { "Content-Type": req.headers.get("content-type") ?? "" },
      }).formData();
      const files = form.getAll("files");
      if (!files.length || files.length > 5)
        throw new WebError("CHOOSE_EMAIL_FILES");
      const results = [];
      for (const file of files) {
        if (
          typeof file === "string" ||
          file.size > 3 * 1024 * 1024 ||
          !file.name.toLowerCase().endsWith(".eml")
        )
          throw new WebError("CHOOSE_EMAIL_FILES");
        try {
          for (const original of await parseEml(
            new Uint8Array(await file.arrayBuffer()),
          )) {
            for (const code of original.omittedOriginals ?? []) results.push({ status: "ERROR", code });
            results.push(
              await ingestOriginal(db, {
                userId: session.userId,
                source: { kind: "FORWARDED_EML" },
                original,
              }),
            );
          }
        } catch (error) {
          if (error instanceof EmlError)
            results.push({ status: "ERROR", code: error.code });
          else throw error;
        }
      }
      return response({ results });
    }
    const body = await requestJson(req);
    if (path === "review") {
      const id = validUuid(body.reviewId);
      if (body.action === "dismiss")
        await dismissReview(db, session.userId, id);
      else if (body.action === "assign") {
        const overrides: Pick<CreateInput, "kind" | "occurredAt"> = {};
        if (body.kind)
          overrides.kind = body.kind as NonNullable<CreateInput["kind"]>;
        if (body.occurredAt)
          overrides.occurredAt = safeText(body.occurredAt, 40);
        await resolveReviewAssign(
          db,
          session.userId,
          id,
          validUuid(body.attemptId),
          overrides,
        );
      } else if (body.action === "create") {
        const input: CreateInput = body.openingId
          ? { openingId: validUuid(body.openingId) }
          : {
              company: safeText(body.company, 80),
              title: safeText(body.title, 100),
            };
        if (body.applicantEmail) {
          const email = safeText(body.applicantEmail, 254);
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            throw new WebError("INVALID_EMAIL");
          input.applicantEmail = email.toLowerCase();
        }
        if (body.kind)
          input.kind = body.kind as NonNullable<CreateInput["kind"]>;
        if (body.occurredAt) input.occurredAt = safeText(body.occurredAt, 40);
        if (body.openingId) input.openingId = validUuid(body.openingId);
        await resolveReviewCreate(db, session.userId, id, input);
      } else throw new WebError("INVALID_FORM");
      return response({ ok: true });
    }
    if (path === "event") {
      if (body.state !== "ACCEPTED" && body.state !== "REJECTED")
        throw new WebError("INVALID_FORM");
      await setEventState(
        db,
        session.userId,
        validUuid(body.eventId),
        body.state,
      );
      return response({ ok: true });
    }
    if (path === "status") {
      await setAttemptStatus(db, session.userId, validUuid(body.attemptId), {
        stage: body.stage as Stage,
        outcome: body.outcome as Outcome,
      });
      return response({ ok: true });
    }
    if (path === "submission-date") {
      await correctSubmissionDate(
        db,
        session.userId,
        validUuid(body.attemptId),
        safeText(body.occurredAt, 40),
      );
      return response({ ok: true });
    }
    if (path === "delete-account") {
      if (body.confirm !== "DELETE") throw new WebError("CONFIRM_DELETE");
      // Refuse to purge active grants; disconnect/revoke each first.
      await db.transaction(async (tx) => {
        await tx.query("SELECT id FROM ledger_users WHERE id=$1 FOR UPDATE", [
          session.userId,
        ]);
        const active = await tx.query(
          "SELECT id FROM connected_mailboxes WHERE user_id=$1 AND sync_state<>'DISCONNECTED'",
          [session.userId],
        );
        if (active.rows.length) throw new WebError("DISCONNECT_FIRST");
        await tx.query("DELETE FROM ledger_users WHERE id=$1", [
          session.userId,
        ]);
      });
      const out = response({ ok: true });
      out.cookies.set(COOKIE, "", { ...cookieOptions(), maxAge: 0 });
      return out;
    }
    if (["connect", "sync", "disconnect", "retry-failed", "recheck"].includes(path)) {
      if (session.isDemo) throw new WebError("DEMO_ONLY", 403);
      const cfg = googleConfig();
      if (path === "connect") {
        if (body.dedicated !== true)
          throw new WebError("DEDICATED_ACCOUNT_REQUIRED");
        return oauthStart("gmail", session.userId);
      }
      if (path === "disconnect")
        return response(
          await disconnectMailbox(
            db,
            cfg.tokenKey,
            session.userId,
            validUuid(body.mailboxId),
          ),
        );
      if (path === "recheck") {
        const id = validUuid(body.mailboxId);
        await rateLimit(db, `recheck:${session.userId}`, 3);
        const result = await requestMailboxRecheck(db, session.userId, id);
        if (result === "NOT_FOUND") throw new WebError("NOT_FOUND", 404);
        if (result === "BUSY") throw new WebError("SYNC_BUSY", 409);
        if (result === "IN_PROGRESS") throw new WebError("RECHECK_IN_PROGRESS", 409);
      }
      if (path === "retry-failed") {
        const id = validUuid(body.mailboxId);
        await db.query(
          `UPDATE processing_tasks SET state='PENDING',attempts=0,next_attempt_at=now(),safe_error_code=NULL,outcome=NULL,finished_at=NULL
          WHERE user_id=$1 AND mailbox_id=$2 AND state='FAILED' AND EXISTS(SELECT 1 FROM connected_mailboxes m WHERE m.id=$2 AND m.user_id=$1 AND m.sync_state<>'DISCONNECTED')`,
          [session.userId, id],
        );
      }
      const deps = {
        db,
        clientFor: gmailClientFactory(db, {
          tokenKey: cfg.tokenKey,
          clientId: cfg.googleClientId,
          clientSecret: cfg.googleClientSecret,
        }),
        budgetMs: 240000,
      };
      return response({
        runs: body.mailboxId
          ? [
              await syncMailbox(deps, validUuid(body.mailboxId), {
                userId: session.userId,
              }),
            ]
          : await syncAllMailboxes(deps, { userId: session.userId }),
      });
    }
    return response({ error: "NOT_FOUND" }, 404);
  } catch (error) {
    return fail(error);
  }
}
