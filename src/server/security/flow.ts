import { pkcePair, randomToken } from "./oauth.ts";
import { signToken, verifyToken } from "./tokens.ts";
import { secureEqual, WebError } from "./web.ts";

export interface OAuthFlow {
  purpose: "login" | "gmail";
  state: string;
  nonce: string;
  verifier: string;
  userId: string | null;
}
export function createFlow(
  secret: Buffer,
  purpose: OAuthFlow["purpose"],
  userId: string | null,
  now = new Date(),
): { flow: OAuthFlow; cookie: string; challenge: string } {
  const pair = pkcePair();
  const flow: OAuthFlow = {
    purpose,
    userId,
    state: randomToken(),
    nonce: randomToken(),
    verifier: pair.verifier,
  };
  return {
    flow,
    cookie: signToken(secret, "oauth-flow", flow, now, 600),
    challenge: pair.challenge,
  };
}
export function validateFlow(
  secret: Buffer,
  cookie: string,
  state: string,
  purpose: OAuthFlow["purpose"],
  userId: string | null,
  now = new Date(),
): OAuthFlow {
  const flow = verifyToken<OAuthFlow>(secret, "oauth-flow", cookie, now);
  if (
    !flow ||
    flow.purpose !== purpose ||
    typeof flow.state !== "string" ||
    typeof flow.nonce !== "string" ||
    typeof flow.verifier !== "string" ||
    !secureEqual(flow.state, state) ||
    flow.userId !== userId
  )
    throw new WebError("OAUTH_STATE_INVALID", 403);
  return flow;
}
