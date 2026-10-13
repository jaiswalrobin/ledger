import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./db.ts";
import { createHash } from "node:crypto";

/** Migration files wrap themselves in BEGIN/COMMIT; the runner owns the transaction instead. */
export function stripTransactionControl(sql: string): string {
  return sql.replace(/^\s*BEGIN;\s*/im, "").replace(/\s*COMMIT;\s*$/i, "\n");
}

/** Applies `migrations/*.sql` in filename order, once each, atomically with its bookkeeping row. */
export async function applyMigrations(
  db: Db,
  directory: string,
): Promise<string[]> {
  const files = (await readdir(directory))
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const sources = await Promise.all(
    files.map(async (name) => ({
      name,
      sql: await readFile(join(directory, name), "utf8"),
    })),
  );
  return db.transaction(async (tx) => {
    // Transaction-scoped locks work with pooled PostgreSQL connections and concurrent deploys.
    await tx.query("SELECT pg_advisory_xact_lock(78143901)");
    await tx.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now(),checksum text)",
    );
    await tx.exec(
      "ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text",
    );
    const applied = new Map(
      (
        await tx.query<{ name: string; checksum: string | null }>(
          "SELECT name,checksum FROM schema_migrations",
        )
      ).rows.map((r) => [r.name, r.checksum]),
    );
    const ran: string[] = [];
    for (const source of sources) {
      const checksum = createHash("sha256").update(source.sql).digest("hex");
      if (applied.has(source.name)) {
        const saved = applied.get(source.name);
        if (saved && saved !== checksum)
          throw new Error("MIGRATION_CHECKSUM_MISMATCH");
        // Legacy filename-only records acquire a baseline once on upgrade.
        if (!saved)
          await tx.query(
            "UPDATE schema_migrations SET checksum=$2 WHERE name=$1",
            [source.name, checksum],
          );
        continue;
      }
      await tx.exec(stripTransactionControl(source.sql));
      await tx.query(
        "INSERT INTO schema_migrations(name,checksum)VALUES($1,$2)",
        [source.name, checksum],
      );
      ran.push(source.name);
    }
    return ran;
  });
}
