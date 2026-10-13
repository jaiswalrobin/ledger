import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db.ts";
import { isAllowed } from "../auth.ts";

export class WebError extends Error {
  readonly status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}
export const COOKIE = "ledger_session";
export interface BrowserSession {
  userId: string;
  isDemo: boolean;
  email: string | null;
}
export const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export function secureEqual(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function assertOrigin(request: Request, expected: string): void {
  if (request.headers.get("origin") !== expected)
    throw new WebError("ORIGIN_REQUIRED", 403);
}
export function validUuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new WebError("INVALID_ITEM");
  return value;
}
export function safeText(value: unknown, max = 200): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f<>]/.test(value)
  )
    throw new WebError("INVALID_FORM");
  return value.trim();
}
export async function requestBytes(
  request: Request,
  max: number,
): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > max)
    throw new WebError("UPLOAD_TOO_LARGE", 413);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > max) {
      await reader.cancel();
      throw new WebError("UPLOAD_TOO_LARGE", 413);
    }
    chunks.push(part.value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
export async function requestJson(
  request: Request,
): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(await requestBytes(request, 16384)).toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new WebError("INVALID_FORM");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof WebError) throw error;
    throw new WebError("INVALID_FORM");
  }
}
export async function createSession(
  db: Db,
  userId: string,
  isDemo: boolean,
): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await db.query(
    "INSERT INTO browser_sessions(token_hash,user_id,is_demo,expires_at)VALUES($1,$2,$3,now()+interval '7 days')",
    [hash(token), userId, isDemo],
  );
  return token;
}
export async function readSession(
  db: Db,
  token: string | undefined,
  allowedEmails: readonly string[],
): Promise<BrowserSession | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const rows = await db.query<{
    user_id: string;
    is_demo: boolean;
    login_email: string | null;
  }>(
    `SELECT s.user_id,s.is_demo,u.login_email FROM browser_sessions s
    JOIN ledger_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`,
    [hash(token)],
  );
  const row = rows.rows[0];
  if (!row) return null;
  if (
    !row.is_demo &&
    (!row.login_email || !isAllowed(row.login_email, allowedEmails))
  )
    return null;
  return { userId: row.user_id, isDemo: row.is_demo, email: row.login_email };
}
export async function logout(db: Db, token: string | undefined): Promise<void> {
  if (token)
    await db.query("DELETE FROM browser_sessions WHERE token_hash=$1", [
      hash(token),
    ]);
}
export async function rateLimit(
  db: Db,
  key: string,
  maximum = 15,
): Promise<void> {
  const result = await db.query<{ attempts: number }>(
    `INSERT INTO browser_rate_limits(bucket,attempts,reset_at)VALUES($1,1,now()+interval '15 minutes')
    ON CONFLICT(bucket)DO UPDATE SET attempts=CASE WHEN browser_rate_limits.reset_at<now() THEN 1 ELSE browser_rate_limits.attempts+1 END,
    reset_at=CASE WHEN browser_rate_limits.reset_at<now() THEN now()+interval '15 minutes' ELSE browser_rate_limits.reset_at END RETURNING attempts`,
    [hash(key)],
  );
  if (result.rows[0]!.attempts > maximum)
    throw new WebError("RATE_LIMITED", 429);
}
