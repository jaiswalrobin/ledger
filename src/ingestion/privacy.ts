/** Secondary transient-body screen. Headers alone cannot detect hidden credentials. */
export function hasSensitiveContent(text: string): boolean {
  return (
    /\b(?:otp|one[ -]?time (?:password|code)|verification code|security code|passcode|password reset|reset (?:your )?password|magic link|sign[ -]?in (?:code|link)|login (?:code|link)|access token|refresh token)\b/i.test(
      text,
    ) ||
    /https?:\/\/\S*[?&#](?:token|code|secret|password|signature|sig|auth|session|key|ticket)=/i.test(
      text,
    ) ||
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(text)
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
    hasSensitiveContent(clean)
  )
    return null;
  return clean;
}
