/** Parse Vercel dotenv as data, never shell code. Export only the migration connection. */
import { readFile, rm } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";
const file = process.argv[2] ?? ".vercel/.env.production.local";
let exitCode = 1;
try {
  const values = parseEnv(await readFile(file, "utf8"));
  if (process.env.GITHUB_ACTIONS === "true") {
    for (const value of Object.values(values)) {
      if (value && value.length >= 6)
        process.stdout.write(
          `::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`,
        );
    }
  }
  const database = values.DATABASE_URL_UNPOOLED;
  if (!database) throw new Error("MIGRATION_DATABASE_MISSING");
  await rm(file, { force: true });
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/migrate.ts"],
    {
      env: { ...process.env, DATABASE_URL: database },
      stdio: "inherit",
    },
  );
  exitCode = result.status ?? 1;
} catch {
  console.error(
    "Production migration failed. Check the secure unpooled database setting and migration state.",
  );
} finally {
  await rm(file, { force: true }).catch(() => undefined);
}
process.exit(exitCode);
