const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

/** Phrases that only appear when a message delivers or acts on a credential. */
const CREDENTIAL_PHRASE =
  /\b(?:otp|one[ -]?time (?:password|code|passcode|pin)|verification code|security code|password reset|reset (?:your )?password|magic link|sign[ -]?in (?:code|link)|log[ -]?in (?:code|link)|access token|refresh token|api key|two[ -]?factor code|2fa code|authentication code)\b/i;

/** "Your passcode is 123456" style delivery; a meeting "Passcode: abc" line is not a login secret. */
const DELIVERED_SECRET =
  /\b(?:your|the|this)\s+(?:passcode|pin|code)\s+(?:is|:)\s*[A-Z0-9-]{4,12}\b/i;

const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/;
const SECRET_PARAMETER = /[?&#](?:token|code|secret|password|signature|sig|auth|session|key|ticket|otp|access_token|refresh_token)=/i;
const ACCOUNT_PATH = /(?:reset|password|passwd|verify|verification|magic|login|log-in|signin|sign-in|sign_in|otp|2fa|mfa|auth)/i;
const TRACKING_PATH = /(?:^|\/)(?:unsub(?:scribe)?|unsubscribe|preferences|email-preferences|track(?:ing)?|click|open)(?:[\/._-]|$)/i;

function normalizeCredentials(value: string): string {
  return value.normalize("NFKC").replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, "");
}
function credentialUrl(raw: string): boolean {
  let decoded = raw.replace(/&amp;/gi, "&");
  // Bound decoding and catch percent-encoded paths, keys, and bearer tokens.
  for (let i=0; i<2; i++) {
    try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; }
    catch { break; }
  }
  decoded = normalizeCredentials(decoded);
  if (JWT.test(decoded)) return true;
  if (!SECRET_PARAMETER.test(decoded)) return false;
  try {
    const url = new URL(decoded);
    if (ACCOUNT_PATH.test(`${url.hostname}${url.pathname}`)) return true;
    if (/[?&#](?:secret|password|access_token|refresh_token)=/i.test(decoded)) return true;
    // Unknown or portal-access tokens may be credentials. Only clear tracking
    // and unsubscribe purposes are exempt, and those URLs are never retained.
    return !TRACKING_PATH.test(url.pathname);
  } catch { return true; }
}

/**
 * Secondary transient-body screen. Headers alone cannot detect hidden credentials.
 *
 * It targets messages that deliver or act on a credential (OTP, password reset, magic sign-in
 * link, bearer token). Ordinary tracking, unsubscribe and "view your application" links carry
 * opaque query tokens in almost every ATS email; clear tracking/unsubscribe links do not make
 * the whole email a credential delivery. Unknown access links still fail closed. Links are never persisted:
 * fields pass through `safeField`, and canonical URLs come only from reviewed ATS schemas.
 */
export function hasSensitiveContent(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeCredentials(text);
  const urls = normalized.match(URL_PATTERN) ?? [];
  if (JWT.test(normalized) || urls.some(credentialUrl)) return true;
  const prose = normalized.replace(URL_PATTERN, " ");
  return (
    CREDENTIAL_PHRASE.test(prose) ||
    DELIVERED_SECRET.test(prose) ||
    JWT.test(prose)
  );
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
