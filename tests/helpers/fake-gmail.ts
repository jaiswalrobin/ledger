import {
  GmailError,
  type GmailClient,
  type MessageHeadersView,
} from "../../src/server/gmail/client.ts";
import { buildEml, type EmlSpec } from "./eml.ts";

interface Stored {
  raw: string;
  labels: string[];
  internalDate: number;
}

/** In-memory Gmail: messages, a history log, pagination, and injectable failures. */
export class FakeGmail implements GmailClient {
  address = "jobs@example.org";
  historyId = 1000;
  /** startHistoryId values below this behave like an expired cursor (HTTP 404). */
  minValidHistoryId = 0;
  pageSize = 2;
  readonly messages = new Map<string, Stored>();
  private readonly log: { historyId: number; id: string }[] = [];
  readonly calls = {
    profile: 0,
    list: 0,
    history: 0,
    headers: [] as string[],
    raw: [] as string[],
  };
  /** message id -> number of times getRaw should throw rate_limited before succeeding */
  rateLimitRaw = new Map<string, number>();
  /** ids whose listing should be omitted from queries (used to model messages missed by a window) */
  hiddenFromQueries = new Set<string>();

  add(
    id: string,
    spec: EmlSpec | string,
    labels: string[] = ["INBOX"],
    internalDate?: number,
  ): this {
    const raw = typeof spec === "string" ? spec : buildEml(spec);
    const dateHeader = /^Date: (.+)$/m.exec(raw)?.[1];
    this.messages.set(id, {
      raw,
      labels,
      internalDate:
        internalDate ?? (dateHeader ? Date.parse(dateHeader) : Date.now()),
    });
    this.historyId += 1;
    this.log.push({ historyId: this.historyId, id });
    return this;
  }

  async getProfile() {
    this.calls.profile += 1;
    return { emailAddress: this.address, historyId: String(this.historyId) };
  }

  async listMessageIds(q: string, pageToken?: string) {
    this.calls.list += 1;
    const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0) * 1000;
    const all = [...this.messages.entries()]
      .filter(
        ([id, m]) => m.internalDate >= after && !this.hiddenFromQueries.has(id),
      )
      .map(([id]) => id);
    const start = pageToken ? Number(pageToken) : 0;
    const ids = all.slice(start, start + this.pageSize);
    const next = start + this.pageSize;
    return {
      ids,
      ...(next < all.length ? { nextPageToken: String(next) } : {}),
    };
  }

  async getHeaders(id: string): Promise<MessageHeadersView | null> {
    this.calls.headers.push(id);
    const m = this.messages.get(id);
    if (!m) return null;
    return {
      id,
      from: /^From: (.+)$/m.exec(m.raw)?.[1] ?? "",
      subject: /^Subject: (.+)$/m.exec(m.raw)?.[1] ?? "",
      labelIds: m.labels,
      senderAuthenticated: true,
    };
  }

  async getRaw(id: string) {
    const remaining = this.rateLimitRaw.get(id) ?? 0;
    if (remaining > 0) {
      this.rateLimitRaw.set(id, remaining - 1);
      throw new GmailError("rate_limited");
    }
    this.calls.raw.push(id);
    const m = this.messages.get(id);
    return m ? new TextEncoder().encode(m.raw) : null;
  }

  async listHistory(startHistoryId: string, pageToken?: string) {
    this.calls.history += 1;
    if (Number(startHistoryId) < this.minValidHistoryId)
      throw new GmailError("history_expired");
    const after = this.log
      .filter((e) => e.historyId > Number(startHistoryId))
      .map((e) => e.id);
    const start = pageToken ? Number(pageToken) : 0;
    const ids = after.slice(start, start + this.pageSize);
    const next = start + this.pageSize;
    return {
      ids,
      historyId: String(this.historyId),
      ...(next < after.length ? { nextPageToken: String(next) } : {}),
    };
  }
}
