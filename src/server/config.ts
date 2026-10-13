/** Names only: a missing or malformed variable must never echo its value into logs. */
export class ConfigError extends Error {
  readonly names: readonly string[];
  constructor(names: readonly string[]) {
    super("Missing or invalid configuration: " + names.join(", "));
    this.names = names;
  }
}

export interface AppConfig {
  databaseUrl: string;
  /** Absolute origin used to build OAuth redirect URIs; never derived from request headers. */
  appUrl: string;
  authSecret: Buffer;
  allowedEmails: readonly string[];
  googleClientId: string;
  googleClientSecret: string;
  tokenKey: Buffer;
  cronSecret: string;
}

function decodeKey(value: string | undefined): Buffer | null {
  if (!value) return null;
  const key = Buffer.from(value, "base64");
  return key.length === 32 ? key : null;
}

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const bad: string[] = [];
  const text = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) bad.push(name);
    return value ?? "";
  };
  const databaseUrl = text("DATABASE_URL");
  const googleClientId = text("GOOGLE_CLIENT_ID");
  const googleClientSecret = text("GOOGLE_CLIENT_SECRET");
  const cronSecret = text("CRON_SECRET");
  if (cronSecret && cronSecret.length < 24) bad.push("CRON_SECRET");

  const appUrlRaw = env["APP_URL"]?.trim().replace(/\/+$/, "") ?? "";
  let appUrl = "";
  try {
    const url = new URL(appUrlRaw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol === "https:" || (local && url.protocol === "http:")) appUrl = url.origin;
  } catch {
    // reported below
  }
  if (!appUrl) bad.push("APP_URL");

  const secretBytes = Buffer.from(env["AUTH_SECRET"] ?? "", "base64");
  if (secretBytes.length < 32) bad.push("AUTH_SECRET");
  const tokenKey = decodeKey(env["TOKEN_ENCRYPTION_KEY"]);
  if (!tokenKey) bad.push("TOKEN_ENCRYPTION_KEY");

  const allowedEmails = (env["ALLOWED_EMAILS"] ?? "")
    .split(",")
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  if (!allowedEmails.length) bad.push("ALLOWED_EMAILS");

  if (bad.length) throw new ConfigError([...new Set(bad)]);
  return {
    databaseUrl,
    appUrl,
    authSecret: secretBytes,
    allowedEmails,
    googleClientId,
    googleClientSecret,
    tokenKey: tokenKey!,
    cronSecret,
  };
}

let cached: AppConfig | undefined;
export function appConfig(): AppConfig {
  cached ??= parseConfig(process.env);
  return cached;
}
