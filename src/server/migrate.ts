import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./db.ts";
import { createHash } from "node:crypto";
import { normalizedText } from "../domain/normalization.ts";

/** Keep the already deployed 0002 file/checksum immutable. Its original DDL
 * assumes an empty database; adapt only this exact pending historical migration. */
async function applySource(
  tx: Db,
  name: string,
  sql: string,
  checksum: string,
): Promise<void> {
  if (
    name !== "0002_ingestion.sql" ||
    checksum !==
      "ba8a613f1891329cd6f088418dfa9cfc1445f7fb951824322ad31e1ed7b11d1c"
  ) {
    await tx.exec(stripTransactionControl(sql));
    return;
  }
  const marker = "ALTER TABLE companies ADD COLUMN name_key text NOT NULL;";
  const [before, after] = stripTransactionControl(sql).split(marker);
  if (before === undefined || after === undefined)
    throw new Error("LEGACY_MIGRATION_INVALID");
  await tx.exec(before);
  await tx.exec("ALTER TABLE companies ADD COLUMN name_key text");
  const companies = await tx.query<{
    id: string;
    user_id: string;
    canonical_name: string;
  }>("SELECT id,user_id,canonical_name FROM companies ORDER BY id");
  // Preserve every company ID, domain and opening. Do not merge ambiguous legacy
  // records merely because their display names normalize alike.
  const reserved = new Set(
    companies.rows.map((row) =>
      JSON.stringify([row.user_id, normalizedText(row.canonical_name)]),
    ),
  );
  const used = new Set<string>();
  for (const row of companies.rows) {
    let key = normalizedText(row.canonical_name);
    const identity = JSON.stringify([row.user_id, key]);
    if (used.has(identity)) {
      key = `legacy:${row.id}`;
      while (
        reserved.has(JSON.stringify([row.user_id, key])) ||
        used.has(JSON.stringify([row.user_id, key]))
      )
        key = `legacy:${key}`;
    }
    used.add(JSON.stringify([row.user_id, key]));
    await tx.query("UPDATE companies SET name_key=$2 WHERE id=$1", [
      row.id,
      key,
    ]);
  }
  await tx.exec("ALTER TABLE companies ALTER COLUMN name_key SET NOT NULL");
  await tx.exec(after);
}

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
      await applySource(tx, source.name, source.sql, checksum);
      await tx.query(
        "INSERT INTO schema_migrations(name,checksum)VALUES($1,$2)",
        [source.name, checksum],
      );
      ran.push(source.name);
    }
    return ran;
  });
}
