import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./db.ts";

/** Migration files wrap themselves in BEGIN/COMMIT; the runner owns the transaction instead. */
export function stripTransactionControl(sql: string): string {
  return sql.replace(/^\s*BEGIN;\s*/im, "").replace(/\s*COMMIT;\s*$/i, "\n");
}

/** Applies `migrations/*.sql` in filename order, once each, atomically with its bookkeeping row. */
export async function applyMigrations(db: Db, directory: string): Promise<string[]> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const applied = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map(r => r.name));
  const files = (await readdir(directory)).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = stripTransactionControl(await readFile(join(directory, file), "utf8"));
    await db.transaction(async tx => {
      await tx.exec(sql);
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    });
    ran.push(file);
  }
  return ran;
}
