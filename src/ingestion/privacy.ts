const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

/** Phrases that only appear when a message delivers or acts on a credential. */
const CREDENTIAL_PHRASE =
  /\b(?:otp|one[ -]?time (?:password|code|passcode|pin)|verification code|security code|password reset|reset (?:your )?password|magic link|sign[ -]?in (?:code|link)|log[ -]?in (?:code|link)|access token|refresh token|api key|two[ -]?factor code|2fa code|authentication code)\b/i;

/** "Your passcode is 123456" style delivery; a meeting "Passcode: abc" line is not a login secret. */
const DELIVERED_SECRET =
  /\b(?:your|the|this)\s+(?:passcode|pin|code)\s+(?:is|:)\s*[A-Z0-9-]{4,12}\b/i;

/** A tokenised link whose own host/path says it signs in, resets, or verifies an account. */
const CREDENTIAL_LINK =
  /^https?:\/\/[^?#\s]*(?:reset|password|passwd|verify|verification|magic|login|log-in|signin|sign-in|sign_in|otp|2fa|mfa|auth)[^?#\s]*[?&#][^\s]*\b(?:token|code|secret|password|signature|sig|auth|session|key|ticket|otp)=/i;

const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\b/;

/**
 * Secondary transient-body screen. Headers alone cannot detect hidden credentials.
 *
 * It targets messages that deliver or act on a credential (OTP, password reset, magic sign-in
 * link, bearer token). Ordinary tracking, unsubscribe and "view your application" links carry
 * opaque query tokens in almost every ATS email; treating each as a credential silently drops
 * valid confirmations, interview invitations and rejections. Those links are never persisted:
 * fields pass through `safeField`, and canonical URLs come only from reviewed ATS schemas.
 */
export function hasSensitiveContent(text: string): boolean {
  if (!text) return false;
  const urls = text.match(URL_PATTERN) ?? [];
  if (urls.some((url) => CREDENTIAL_LINK.test(url))) return true;
  const prose = text.replace(URL_PATTERN, " ");
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
