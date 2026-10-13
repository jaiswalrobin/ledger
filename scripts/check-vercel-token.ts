/**
 * Verifies VERCEL_TOKEN against VERCEL_ORG_ID before a release touches anything. Also usable by hand
 * without printing the token:
 *   read -rs VERCEL_TOKEN && export VERCEL_TOKEN
 *   VERCEL_ORG_ID=team_... node --experimental-strip-types scripts/check-vercel-token.ts
 */
import { checkVercelToken, describeVerdict } from "./vercel-token.ts";
try {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`MISSING_${name}`);
    return value;
  };
  const check = await checkVercelToken({
    token: required("VERCEL_TOKEN"),
    orgId: required("VERCEL_ORG_ID"),
  });
  const message = describeVerdict(check);
  if (check.verdict === "ok") console.log(message);
  else {
    console.error(`::error::${message}`);
    process.exitCode = 1;
  }
} catch (error) {
  const message =
    error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "TOKEN_CHECK_FAILED";
  console.error(`::error::${message}`);
  process.exitCode = 1;
}
