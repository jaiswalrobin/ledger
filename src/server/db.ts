import type { Pool, PoolClient } from "pg";
import type { PGlite, Transaction } from "@electric-sql/pglite";

export type Row = Record<string, unknown>;

/**
 * Minimal database surface used by every repository. Two adapters satisfy it:
 * `pg` for deployed Postgres (Neon) and PGlite for hermetic tests. Repositories never
 * import a driver directly, so swapping or faking the database stays cheap.
 */
export interface Db {
  query<T extends object = Row>(text: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  /** Multi-statement SQL without parameters (migrations). */
  exec(sql: string): Promise<void>;
  /** Nested calls join the outer transaction. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

export function fromPool(pool: Pool): Db {
  const wrap = (target: Pool | PoolClient, inTransaction: boolean): Db => {
    const db: Db = {
      async query<T extends object = Row>(text: string, params?: readonly unknown[]) {
        const result = await target.query(text, params ? [...params] : undefined);
        return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
      },
      async exec(sql) {
        await target.query(sql);
      },
      async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
        if (inTransaction) return fn(db);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn(wrap(client, true));
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    };
    return db;
  };
  return wrap(pool, false);
}

export function fromPglite(pg: PGlite | Transaction): Db {
  const db: Db = {
    async query<T extends object = Row>(text: string, params?: readonly unknown[]) {
      const result = await pg.query<T>(text, params ? [...params] : []);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    async exec(sql) {
      await pg.exec(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      if ("transaction" in pg) return pg.transaction(tx => fn(fromPglite(tx)));
      return fn(db);
    },
  };
  return db;
}
