/**
 * Classifies a Vercel token the way the release CLI will experience it. The CLI's inspect,
 * promote and rollback begin by asking the API who the token belongs to (GET /v2/user), so a
 * token the REST API accepts can still be unusable for them. Only status codes are read:
 * neither the token nor any response body is ever logged.
 */
export type TokenVerdict =
  | "ok"
  | "invalid-token"
  | "not-a-user-token"
  | "no-team-access"
  | "unexpected";
export interface TokenCheck {
  verdict: TokenVerdict;
  userStatus: number | null;
  teamStatus: number | null;
}
export interface TokenCheckConfig {
  token: string;
  orgId: string;
  fetchFn?: typeof fetch;
}
export async function checkVercelToken(
  config: TokenCheckConfig,
): Promise<TokenCheck> {
  if (!/^(?:team|user)_[A-Za-z0-9]+$/.test(config.orgId))
    throw new Error("INVALID_VERCEL_OWNER");
  const fetchFn = config.fetchFn ?? fetch;
  /** The HTTP status of an authenticated GET, or null when the request itself failed. */
  async function status(path: string): Promise<number | null> {
    try {
      const response = await fetchFn(new URL(path, "https://api.vercel.com"), {
        headers: { authorization: `Bearer ${config.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      await response.body?.cancel();
      return response.status;
    } catch {
      return null;
    }
  }
  const userStatus = await status("/v2/user");
  // Same reading of the API as the CLI: 403 is a rejected token, anything but 200 otherwise
  // is a problem. 404 is the case seen in production: valid for the REST API, no user behind it.
  if (userStatus === 403)
    return { verdict: "invalid-token", userStatus, teamStatus: null };
  if (userStatus === 404)
    return { verdict: "not-a-user-token", userStatus, teamStatus: null };
  if (userStatus !== 200)
    return { verdict: "unexpected", userStatus, teamStatus: null };
  if (!config.orgId.startsWith("team_"))
    return { verdict: "ok", userStatus, teamStatus: null };
  const teamStatus = await status(`/v2/teams/${config.orgId}`);
  if (teamStatus === 200) return { verdict: "ok", userStatus, teamStatus };
  if (teamStatus === 403 || teamStatus === 404)
    return { verdict: "no-team-access", userStatus, teamStatus };
  return { verdict: "unexpected", userStatus, teamStatus };
}
export function describeVerdict(check: TokenCheck): string {
  const seen = `GET /v2/user -> ${check.userStatus ?? "no response"}, GET /v2/teams/<owner> -> ${check.teamStatus ?? "not asked"}`;
  switch (check.verdict) {
    case "ok":
      return `VERCEL_TOKEN works for the Vercel CLI (${seen}).`;
    case "invalid-token":
      return `VERCEL_TOKEN was rejected by Vercel (${seen}). It is invalid, expired or revoked, or an older secret is in effect. Create a new token and replace the production environment secret (docs/deployment.md, "Credential diagnostics").`;
    case "not-a-user-token":
      return `VERCEL_TOKEN is accepted by Vercel but is not tied to a user (${seen}). The Vercel CLI cannot run inspect, promote or rollback with it, and flags such as --scope do not change that. Create the token in the Vercel dashboard (Account Settings, Tokens) while signed in as a member of the team, and replace the production environment secret (docs/deployment.md, "Credential diagnostics").`;
    case "no-team-access":
      return `VERCEL_TOKEN belongs to a user but cannot read the team in VERCEL_ORG_ID (${seen}). Recreate it with the team in its scope (docs/deployment.md, "Credential diagnostics").`;
    case "unexpected":
      return `Could not verify VERCEL_TOKEN (${seen}). This looks like a Vercel outage or a network problem rather than a bad token; re-run the workflow.`;
  }
}
