import { Pool } from "pg";
import { fromPool } from "../src/server/db.ts";
import { applyMigrations } from "../src/server/migrate.ts";

if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required for migrations");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const ran = await applyMigrations(
    fromPool(pool),
    new URL("../migrations", import.meta.url).pathname,
  );
  console.log(`Applied ${ran.length} migration(s).`);
} catch {
  console.error("Migration failed. Check database access and migration state.");
  process.exitCode = 1;
} finally {
  await pool.end();
}
