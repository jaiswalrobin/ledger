/** Production-only administrative operations. No credentials or response bodies are logged. */
import { randomBytes } from "node:crypto";
export interface AdminConfig {
  token: string;
  projectId: string;
  orgId: string;
  fetchFn?: typeof fetch;
}
class OperationError extends Error {}
interface Deployment {
  id?: string;
  uid?: string;
  target?: string | null;
  projectId?: string;
}
interface Variable {
  key: string;
  target?: string[];
}
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^dpl_[A-Za-z0-9]+$/.test(value);
export function admin(config: AdminConfig) {
  if (!/^(?:team|user)_[A-Za-z0-9]+$/.test(config.orgId))
    throw new OperationError("INVALID_VERCEL_OWNER");
  const fetchFn = config.fetchFn ?? fetch;
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const url = new URL(path, "https://api.vercel.com");
    if (url.origin !== "https://api.vercel.com")
      throw new OperationError("INVALID_API_DESTINATION");
    if (config.orgId.startsWith("team_"))
      url.searchParams.set("teamId", config.orgId);
    const response = await fetchFn(url, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new OperationError(`VERCEL_API_HTTP_${response.status}`);
    if (response.status === 204) return {};
    const reader = response.body?.getReader();
    if (!reader) return {};
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new OperationError("API_RESPONSE_TOO_LARGE");
      }
      chunks.push(part.value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      throw new OperationError("INVALID_API_RESPONSE");
    }
  }
  const projectPath = `/v9/projects/${encodeURIComponent(config.projectId)}`;
  async function productionId(): Promise<string> {
    const project = await request(projectPath);
    const targets = project.targets as { production?: Deployment } | undefined;
    const id = targets?.production?.id;
    if (project.id !== config.projectId || !validId(id))
      throw new OperationError("PRODUCTION_DEPLOYMENT_NOT_VERIFIED");
    return id;
  }
  async function previewIds(): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const url = new URL("/v6/deployments", "https://api.vercel.com");
      url.searchParams.set("projectId", config.projectId);
      url.searchParams.set("target", "preview");
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("until", cursor);
      const list = await request(url.pathname + url.search);
      if (!Array.isArray(list.deployments))
        throw new OperationError("INVALID_DEPLOYMENT_LIST");
      for (const deployment of list.deployments as Deployment[]) {
        const id = deployment.uid ?? deployment.id;
        if (!validId(id)) throw new OperationError("INVALID_DEPLOYMENT_ID");
        ids.push(id);
      }
      const next = (
        list.pagination as { next?: number | string | null } | undefined
      )?.next;
      if (next == null) return [...new Set(ids)];
      cursor = String(next);
      if (!/^\d+$/.test(cursor) || seen.has(cursor))
        throw new OperationError("INVALID_PAGINATION");
      seen.add(cursor);
    }
    throw new OperationError("INCOMPLETE_PREVIEW_INVENTORY");
  }
  async function validatePreview(id: string, live: string) {
    const deployment = (await request(
      `/v13/deployments/${encodeURIComponent(id)}`,
    )) as Deployment;
    if (
      (deployment.id ?? deployment.uid) !== id ||
      deployment.projectId !== config.projectId ||
      id === live ||
      !(deployment.target === null || deployment.target === "preview")
    )
      throw new OperationError("REFUSE_NON_PREVIEW_DEPLOYMENT");
  }
  return {
    async removePreviews(dryRun: boolean): Promise<number> {
      const live = await productionId(),
        ids = await previewIds();
      // Validate the complete inventory before any mutation.
      for (const id of ids) await validatePreview(id, live);
      if (dryRun) return ids.length;
      for (const id of ids) {
        await validatePreview(id, await productionId());
        await request(`/v13/deployments/${encodeURIComponent(id)}`, "DELETE");
      }
      if ((await previewIds()).length !== 0)
        throw new OperationError("PREVIEWS_REMAIN");
      return ids.length;
    },
    async configureGoogle(input: {
      clientId: string;
      clientSecret: string;
      allowedEmails: string;
    }): Promise<string[]> {
      if (
        !input.clientId.endsWith(".apps.googleusercontent.com") ||
        !input.clientSecret.trim()
      )
        throw new OperationError("GOOGLE_CLIENT_CONFIGURATION_REQUIRED");
      const emails = input.allowedEmails
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
      if (
        !emails.length ||
        emails.some((x) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))
      )
        throw new OperationError("LOGIN_ALLOWLIST_REQUIRED");
      await productionId();
      if ((await previewIds()).length !== 0)
        throw new OperationError("REMOVE_PREVIEWS_BEFORE_GOOGLE_SETUP");
      const listed = await request(`${projectPath}/env?decrypt=false`);
      if (!Array.isArray(listed.envs))
        throw new OperationError("INVALID_VARIABLE_LIST");
      const production = (listed.envs as Variable[]).filter((x) =>
        x.target?.includes("production"),
      );
      const keys = [
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "ALLOWED_EMAILS",
        "AUTH_SECRET",
        "TOKEN_ENCRYPTION_KEY",
      ];
      if (
        production.some(
          (x) =>
            keys.includes(x.key) && x.target?.some((t) => t !== "production"),
        )
      )
        throw new OperationError("GOOGLE_VARIABLE_SHARED_WITH_PREVIEW");
      const exists = (key: string) => production.some((x) => x.key === key);
      if (exists("GOOGLE_CLIENT_ID") !== exists("GOOGLE_CLIENT_SECRET"))
        throw new OperationError("PARTIAL_GOOGLE_CLIENT_CONFIGURATION");
      const values: Record<string, string> = {
        GOOGLE_CLIENT_ID: input.clientId.trim(),
        GOOGLE_CLIENT_SECRET: input.clientSecret,
        ALLOWED_EMAILS: emails.join(","),
        AUTH_SECRET: randomBytes(32).toString("base64"),
        TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      };
      const created: string[] = [];
      for (const key of keys) {
        // Never rotate an existing signing/encryption key or overwrite hidden credentials.
        if (exists(key)) continue;
        await request(
          `/v10/projects/${encodeURIComponent(config.projectId)}/env`,
          "POST",
          {
            key,
            value: values[key],
            type: "sensitive",
            target: ["production"],
          },
        );
        created.push(key);
      }
      return created;
    },
  };
}
