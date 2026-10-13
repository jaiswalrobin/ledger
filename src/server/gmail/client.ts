import { EML_LIMITS } from "../../ingestion/eml.ts";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export type GmailErrorCode =
  | "unauthorized"
  | "history_expired"
  | "rate_limited"
  | "forbidden"
  | "server"
  | "network"
  | "oversized";

/** Code only. Gmail's error body is never copied into messages or logs. */
export class GmailError extends Error {
  readonly code: GmailErrorCode;
  constructor(code: GmailErrorCode) {
    super(code);
    this.code = code;
  }
}

export interface MessageHeadersView {
  id: string;
  from: string;
  subject: string;
  labelIds: string[];
  senderAuthenticated?: boolean;
}

/**
 * The only Gmail surface Ledger uses: read-only, header-first. `getRaw` is called solely for
 * messages the header gate approved; it returns the original RFC 822 bytes for transient parsing.
 */
export interface GmailClient {
  getProfile(): Promise<{ emailAddress: string; historyId: string }>;
  listMessageIds(
    q: string,
    pageToken?: string,
  ): Promise<{ ids: string[]; nextPageToken?: string }>;
  /** null when the message no longer exists. */
  getHeaders(id: string): Promise<MessageHeadersView | null>;
  getRaw(id: string): Promise<Uint8Array | null>;
  /** Throws GmailError("history_expired") when startHistoryId is too old (HTTP 404). */
  listHistory(
    startHistoryId: string,
    pageToken?: string,
  ): Promise<{ ids: string[]; historyId: string; nextPageToken?: string }>;
}

/** Conservative candidate queries with deliberately overlapping coverage. Message ids are deduped downstream. */
export function candidateQueries(afterEpochSeconds: number): string[] {
  const base = `after:${afterEpochSeconds} -in:spam -in:trash -in:sent -in:drafts`;
  const atsSenders = [
    "greenhouse.io",
    "greenhouse-mail.io",
    "lever.co",
    "myworkday.com",
    "myworkdayjobs.com",
    "ashbyhq.com",
    "smartrecruiters.com",
    "icims.com",
    "jobvite.com",
    "workable.com",
  ];
  return [
    `${base} (${atsSenders.map((d) => `from:${d}`).join(" OR ")})`,
    `${base} subject:(application OR applying OR applied OR interview OR assessment OR "coding challenge" OR candidate OR recruiter OR "job offer")`,
  ];
}

export function createGmailClient(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): GmailClient {
  async function call(
    path: string,
    params: Record<string, string | string[] | undefined>,
  ): Promise<unknown> {
    const url = new URL(API + path);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value])
        url.searchParams.append(key, v);
    }
    let response: Response;
    try {
      response = await fetchFn(url, {
        headers: { authorization: `Bearer ${accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new GmailError("network");
    }
    if (response.ok) {
      const limit = 6 * 1024 * 1024;
      if (Number(response.headers.get("content-length")) > limit) {
        await response.body?.cancel();
        throw new GmailError("oversized");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new GmailError("server");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > limit) {
          await reader.cancel();
          throw new GmailError("oversized");
        }
        chunks.push(part.value);
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new GmailError("server");
      }
    }
    if (response.status === 401) throw new GmailError("unauthorized");
    if (response.status === 404) throw new GmailError("history_expired");
    if (response.status === 429) throw new GmailError("rate_limited");
    if (response.status === 403) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { errors?: { reason?: string }[] };
      };
      const reason = body.error?.errors?.[0]?.reason ?? "";
      throw new GmailError(
        /rateLimit|quota/i.test(reason) ? "rate_limited" : "forbidden",
      );
    }
    throw new GmailError(response.status >= 500 ? "server" : "forbidden");
  }

  /** 404 on a single message means deleted, which is not an error for sync. */
  async function callMessage(
    id: string,
    params: Record<string, string | string[] | undefined>,
  ): Promise<Record<string, unknown> | null> {
    try {
      return (await call(
        `/messages/${encodeURIComponent(id)}`,
        params,
      )) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof GmailError && error.code === "history_expired")
        return null;
      throw error;
    }
  }

  return {
    async getProfile() {
      const r = (await call("/profile", {})) as {
        emailAddress: string;
        historyId: string;
      };
      return { emailAddress: r.emailAddress, historyId: String(r.historyId) };
    },
    async listMessageIds(q, pageToken) {
      const r = (await call("/messages", {
        q,
        maxResults: "500",
        pageToken,
        includeSpamTrash: "false",
      })) as { messages?: { id: string }[]; nextPageToken?: string };
      return {
        ids: (r.messages ?? []).map((m) => m.id),
        ...(r.nextPageToken ? { nextPageToken: r.nextPageToken } : {}),
      };
    },
    async getHeaders(id) {
      const r = await callMessage(id, {
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Authentication-Results"],
      });
      if (!r) return null;
      const headers =
        (
          r["payload"] as
            { headers?: { name: string; value: string }[] } | undefined
        )?.headers ?? [];
      const header = (name: string) =>
        headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";
      const from = header("from");
      const domain = /@([A-Za-z0-9.-]+)(?:>|\s|$)/
        .exec(from)?.[1]
        ?.toLowerCase();
      const authentication = header("authentication-results");
      const authenticatedDomain =
        authentication.length <= 4096 &&
        /^\s*mx\.google\.com;/i.test(authentication)
          ? /(?:^|;)\s*dmarc=pass\b[^;]*\bheader\.from="?([A-Za-z0-9.-]+)/i
              .exec(authentication)?.[1]
              ?.toLowerCase()
          : null;
      return {
        id,
        from,
        subject: header("subject"),
        labelIds: (r["labelIds"] as string[] | undefined) ?? [],
        senderAuthenticated: !!domain && domain === authenticatedDomain,
      };
    },
    async getRaw(id) {
      const r = await callMessage(id, { format: "raw" });
      if (!r || typeof r["raw"] !== "string") return null;
      if (r["raw"].length > Math.ceil((EML_LIMITS.maxBytes * 4) / 3) + 4)
        throw new GmailError("oversized");
      if (!/^[A-Za-z0-9_-]*={0,2}$/.test(r["raw"]))
        throw new GmailError("server");
      const decoded = new Uint8Array(Buffer.from(r["raw"], "base64url"));
      if (decoded.length > EML_LIMITS.maxBytes)
        throw new GmailError("oversized");
      return decoded;
    },
    async listHistory(startHistoryId, pageToken) {
      const r = (await call("/history", {
        startHistoryId,
        historyTypes: "messageAdded",
        maxResults: "500",
        pageToken,
      })) as {
        history?: { messagesAdded?: { message: { id: string } }[] }[];
        historyId: string;
        nextPageToken?: string;
      };
      const ids = (r.history ?? []).flatMap((h) =>
        (h.messagesAdded ?? []).map((m) => m.message.id),
      );
      return {
        ids,
        historyId: String(r.historyId),
        ...(r.nextPageToken ? { nextPageToken: r.nextPageToken } : {}),
      };
    },
  };
}
