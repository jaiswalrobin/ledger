import { Pool } from "pg";
import { fromPool, type Db } from "./db.ts";
import { parseConfig, type AppConfig } from "./config.ts";

const state = globalThis as typeof globalThis & { ledgerPool?: Pool };
export function runtimeDb(): Db {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_NOT_CONFIGURED");
  state.ledgerPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
  });
  return fromPool(state.ledgerPool);
}
export function siteOrigin(): string {
  let url: URL;
  try {
    url = new URL(process.env.APP_URL ?? "");
  } catch {
    throw new Error("APP_URL_NOT_CONFIGURED");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname))
    )
  )
    throw new Error("APP_URL_NOT_CONFIGURED");
  return url.origin;
}
export function googleReady(): boolean {
  try {
    parseConfig(process.env);
    return true;
  } catch {
    return false;
  }
}
export function googleConfig(): AppConfig {
  return parseConfig(process.env);
}
export function demoEnabled(): boolean {
  return process.env.DEMO_MODE === "true";
}
