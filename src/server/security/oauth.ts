import { createHash, randomBytes } from "node:crypto";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Only a short machine code; Google's error text is never copied (it can contain account details). */
export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export const randomToken = (bytes = 32): string =>
  randomBytes(bytes).toString("base64url");

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

export interface AuthUrlInput {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  nonce: string;
  challenge: string;
  /** Request a refresh token (Gmail connection only). */
  offline: boolean;
}

export function buildAuthUrl(i: AuthUrlInput): string {
  const url = new URL(GOOGLE_AUTH_URL);
  const p = url.searchParams;
  p.set("client_id", i.clientId);
  p.set("redirect_uri", i.redirectUri);
  p.set("response_type", "code");
  p.set("scope", i.scope);
  p.set("state", i.state);
  p.set("nonce", i.nonce);
  p.set("code_challenge", i.challenge);
  p.set("code_challenge_method", "S256");
  if (i.offline) {
    p.set("access_type", "offline");
    p.set("prompt", "consent");
  } else {
    p.set("prompt", "select_account");
  }
  return url.toString();
}

/**
 * The ID token arrives straight from Google's token endpoint over TLS, which OIDC Core §3.1.3.7
 * accepts in place of signature verification. All claims that bind it to THIS request and client
 * are still checked. Returns only what Ledger needs.
 */
export function parseIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string; now: Date },
): { sub: string; email: string } {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OAuthError("bad_id_token");
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    throw new OAuthError("bad_id_token");
  }
  const aud = claims["aud"];
  const audienceOk = Array.isArray(aud)
    ? aud.length > 0 &&
      aud.every((a) => typeof a === "string") &&
      aud.includes(expected.clientId)
    : aud === expected.clientId;
  const azpOk =
    (claims["azp"] === undefined &&
      (!Array.isArray(aud) || aud.length === 1)) ||
    claims["azp"] === expected.clientId;
  const issuerOk =
    claims["iss"] === "https://accounts.google.com" ||
    claims["iss"] === "accounts.google.com";
  const exp = claims["exp"];
  const issued = claims["iat"];
  const fresh =
    typeof exp === "number" &&
    Number.isFinite(exp) &&
    exp * 1000 > expected.now.getTime() &&
    (issued === undefined ||
      (typeof issued === "number" &&
        Number.isFinite(issued) &&
        issued * 1000 <= expected.now.getTime() + 60000));
  const sub = claims["sub"];
  const email = claims["email"];
  if (
    !audienceOk ||
    !azpOk ||
    !issuerOk ||
    !fresh ||
    claims["nonce"] !== expected.nonce
  )
    throw new OAuthError("bad_id_token");
  if (
    claims["email_verified"] !== true ||
    typeof sub !== "string" ||
    !sub ||
    typeof email !== "string" ||
    !email
  )
    throw new OAuthError("unverified_identity");
  return { sub, email: email.toLowerCase() };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  error?: string;
}

async function postForm(
  fetchFn: typeof fetch,
  url: string,
  body: URLSearchParams,
): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new OAuthError("network_error");
  }
  const json = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok)
    throw new OAuthError(
      typeof json.error === "string" && /^[a-z_]{3,40}$/.test(json.error)
        ? json.error
        : "oauth_error",
    );
  return json;
}

export interface ExchangeInput {
  fetchFn?: typeof fetch;
  clientId: string;
  clientSecret: string;
  code: string;
  verifier: string;
  redirectUri: string;
}

export async function exchangeCode(i: ExchangeInput): Promise<{
  accessToken: string;
  refreshToken?: string;
  idToken: string;
  scope: string;
}> {
  const json = await postForm(
    i.fetchFn ?? fetch,
    GOOGLE_TOKEN_URL,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: i.code,
      code_verifier: i.verifier,
      redirect_uri: i.redirectUri,
      client_id: i.clientId,
      client_secret: i.clientSecret,
    }),
  );
  if (!json.access_token || !json.id_token) throw new OAuthError("oauth_error");
  return {
    accessToken: json.access_token,
    idToken: json.id_token,
    scope: json.scope ?? "",
    ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
  };
}

export async function refreshAccessToken(i: {
  fetchFn?: typeof fetch;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<string> {
  const json = await postForm(
    i.fetchFn ?? fetch,
    GOOGLE_TOKEN_URL,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: i.refreshToken,
      client_id: i.clientId,
      client_secret: i.clientSecret,
    }),
  );
  if (!json.access_token) throw new OAuthError("oauth_error");
  return json.access_token;
}

/** Best effort: a failed revoke must not block disconnecting locally. */
export async function revokeToken(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchFn(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    return response.ok;
  } catch {
    return false;
  }
}
