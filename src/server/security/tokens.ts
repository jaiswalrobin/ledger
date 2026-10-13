import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Small signed-envelope format for sessions and OAuth state: base64url(JSON) "." base64url(HMAC).
 * The purpose string is part of the MAC input, so a token minted for one use can never be
 * replayed as another (e.g. an OAuth state cookie cannot act as a session).
 */
function mac(secret: Buffer, purpose: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(`ledger:${purpose}:`).update(payload).digest();
}

export function signToken<T>(secret: Buffer, purpose: string, data: T, now: Date, ttlSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ d: data, exp: Math.floor(now.getTime() / 1000) + ttlSeconds })).toString("base64url");
  return `${payload}.${mac(secret, purpose, payload).toString("base64url")}`;
}

export function verifyToken<T>(secret: Buffer, purpose: string, token: string, now: Date): T | null {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, signature] = parts as [string, string];
  const expected = mac(secret, purpose, payload);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { d: T; exp: number };
    if (typeof parsed.exp !== "number" || parsed.exp * 1000 <= now.getTime()) return null;
    return parsed.d;
  } catch {
    return null;
  }
}
