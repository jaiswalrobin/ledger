import type { ParsedMessage } from "./source.ts";
import type { Sensitivity } from "../domain/types.ts";

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

/** Phrases that only appear when a message delivers or acts on a credential. */
const CREDENTIAL_PHRASE =
  /\b(?:otp|one[ -]?time (?:password|code|passcode|pin)|verification code|security code|password reset|reset (?:your )?password|magic link|sign[ -]?in (?:code|link)|log[ -]?in (?:code|link)|access token|refresh token|api key|two[ -]?factor code|2fa code|authentication code)\b/i;

/** "Your passcode is 123456" style delivery; a meeting "Passcode: abc" line is not a login secret. */
const DELIVERED_SECRET =
  /\b(?:your|the|this)\s+(?:passcode|pin|code)\s+(?:is|:)\s*[A-Z0-9-]{4,12}\b/i;

const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/;
const SECRET_PARAMETER =
  /[?&#](?:token|code|secret|password|signature|sig|auth|session|key|ticket|otp|access_token|refresh_token)=/i;
/** Parameters that only ever carry a secret, whatever the link is for. */
const RAW_SECRET_PARAMETER =
  /[?&#](?:secret|password|otp|access_token|refresh_token)=/i;
/** Paths that change or prove account ownership: a token here is a credential delivery. */
const CREDENTIAL_PATH =
  /(?:reset|password|passwd|verify|verification|magic|otp|2fa|mfa)/i;
const TRACKING_PATH =
  /(?:^|\/)(?:unsub(?:scribe)?|unsubscribe|preferences|email-preferences|track(?:ing)?|click|open|c|ls|wf|e)(?:[\/._-]|$)/i;
/** Signed static assets (logos, fonts, stylesheets) carry signatures, never account access. */
const ASSET_PATH = /\.(?:png|jpe?g|gif|svg|webp|ico|css|woff2?|ttf)$/i;

/**
 * How sensitive a text is, from least to most:
 * - NONE: no secrets; tracking, unsubscribe and signed-asset links are ordinary.
 * - ACCESS_LINK: an opaque token on a portal, assessment, scheduling or login link. Hiring mail is
 *   full of these ("view your application", "start your assessment"). The link is never stored,
 *   so the message may still be read for hiring facts; mail with no hiring signal is skipped.
 * - CREDENTIAL: the message delivers or acts on a credential (codes, password resets, account
 *   verification, magic links, bearer tokens). Nothing derived from it is kept.
 */
export type { Sensitivity };
const RANK: Record<Sensitivity, number> = {
  NONE: 0,
  ACCESS_LINK: 1,
  CREDENTIAL: 2,
};
const higher = (a: Sensitivity, b: Sensitivity): Sensitivity =>
  RANK[b] > RANK[a] ? b : a;

function normalizeCredentials(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, "");
}
function urlSensitivity(raw: string): Sensitivity {
  let decoded = raw.replace(/&amp;/gi, "&");
  // Bound decoding and catch percent-encoded paths, keys, and bearer tokens.
  for (let i = 0; i < 2; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  decoded = normalizeCredentials(decoded);
  if (JWT.test(decoded) || RAW_SECRET_PARAMETER.test(decoded))
    return "CREDENTIAL";
  if (!SECRET_PARAMETER.test(decoded)) return "NONE";
  try {
    const url = new URL(decoded);
    if (CREDENTIAL_PATH.test(`${url.hostname}${url.pathname}`))
      return "CREDENTIAL";
    if (TRACKING_PATH.test(url.pathname) || ASSET_PATH.test(url.pathname))
      return "NONE";
    // Portal, assessment, scheduling and login links: access, but not a credential delivery.
    return "ACCESS_LINK";
  } catch {
    return "CREDENTIAL";
  }
}

/**
 * Secondary transient-body screen. Headers alone cannot detect hidden credentials.
 *
 * A credential delivery (OTP, password reset, account verification, magic sign-in link, bearer
 * token) is CREDENTIAL. Opaque tokens on portal, assessment, scheduling and login links are
 * ACCESS_LINK: they appear in almost every hiring email, so they do not by themselves discard
 * the message (see the pipeline). Links are never persisted either way: fields pass through
 * `safeField`, and canonical URLs come only from reviewed ATS schemas without query strings.
 */
export function sensitivity(text: string): Sensitivity {
  if (!text) return "NONE";
  const normalized = normalizeCredentials(text);
  const prose = normalized.replace(URL_PATTERN, " ");
  if (
    JWT.test(normalized) ||
    CREDENTIAL_PHRASE.test(prose) ||
    DELIVERED_SECRET.test(prose)
  )
    return "CREDENTIAL";
  let level: Sensitivity = "NONE";
  for (const url of normalized.match(URL_PATTERN) ?? []) {
    level = higher(level, urlSensitivity(url));
    if (level === "CREDENTIAL") break;
  }
  return level;
}

/** Any secret-bearing content, including access links. Used to keep values out of storage. */
export const hasSensitiveContent = (text: string): boolean =>
  sensitivity(text) !== "NONE";

/** Every transient representation is screened before extraction, including folded calendar data. */
export function messageSensitivity(message: ParsedMessage): Sensitivity {
  const texts = [
    message.subject,
    message.text,
    ...(message.alternativeTexts ?? []),
    message.inspectionHtml ?? "",
    ...(message.calendarParts ?? []).map((part) =>
      part.content.replace(/\r?\n[ \t]/g, "").replace(/\\[nN]/g, " "),
    ),
  ];
  let level: Sensitivity = "NONE";
  for (const text of texts) level = higher(level, sensitivity(text));
  return level;
}

/** Field-level screen: anything URL-shaped, token-shaped or credential-like is never stored. */
function fieldLooksSensitive(value: string): boolean {
  return (
    hasSensitiveContent(value) ||
    /[?&#](?:token|code|secret|password|signature|sig|auth|session|key|ticket)=/i.test(
      value,
    ) ||
    JWT.test(value)
  );
}

export function safeField(
  value: string | null | undefined,
  limit = 100,
): string | null {
  if (!value) return null;
  const clean = value.trim();
  if (
    !clean ||
    clean.length > limit ||
    /[<>\x00-\x1f]|https?:\/\//i.test(clean) ||
    fieldLooksSensitive(clean)
  )
    return null;
  return clean;
}
