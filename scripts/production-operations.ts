import { admin } from "./vercel-operations.ts";
try {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`MISSING_${name}`);
    return value;
  };
  const client = admin({
    token: required("VERCEL_TOKEN"),
    projectId: required("VERCEL_PROJECT_ID"),
    orgId: required("VERCEL_ORG_ID"),
  });
  const operation = process.argv[2];
  if (operation === "remove-previews") {
    const dryRun = process.env.DRY_RUN !== "false";
    const count = await client.removePreviews(dryRun);
    console.log(
      dryRun
        ? `Verified ${count} preview deployments; dry run made no changes.`
        : `Removed ${count} preview deployments. Production was preserved.`,
    );
  } else if (operation === "configure-google") {
    const created = await client.configureGoogle({
      clientId: required("GOOGLE_CLIENT_ID"),
      clientSecret: required("GOOGLE_CLIENT_SECRET"),
      allowedEmails: required("ALLOWED_EMAILS"),
    });
    console.log(
      `Production variables created: ${created.join(", ") || "none; existing settings preserved"}.`,
    );
    console.log(
      "Redeploy through Ledger CI/CD, then validate Google consent and the dedicated Gmail flow.",
    );
  } else throw new Error("INVALID_OPERATION");
} catch (error) {
  const message =
    error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "OPERATION_FAILED";
  console.error(message);
  process.exitCode = 1;
}
