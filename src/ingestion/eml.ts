import { createHash } from "node:crypto";
import PostalMime from "postal-mime";
import type { Email } from "postal-mime";
import type { ParsedMessage, ParsedOriginal } from "./source.ts";
import { htmlText } from "./html.ts";

export const EML_LIMITS = {
  /** Vercel rejects request bodies above 4.5 MB; stay under it. */
  maxBytes: 4 * 1024 * 1024,
  maxOriginals: 25,
  maxTextChars: 100_000,
  maxHtmlChars: 256_000,
  maxSubjectChars: 1000,
  maxNameChars: 200,
  maxRecipients: 50,
} as const;

export type EmlErrorCode =
  | "EMPTY"
  | "TOO_LARGE"
  | "TOO_MANY"
  | "NOT_A_MESSAGE"
  | "INLINE_FORWARD"
  | "MALFORMED";

/** Carries only a code; never message content. */
export class EmlError extends Error {
  readonly code: EmlErrorCode;
  constructor(code: EmlErrorCode) {
    super(code);
    this.code = code;
  }
}

const PARSE_OPTIONS = {
  attachmentEncoding: "arraybuffer",
  forceRfc822Attachments: true,
  // Attached originals are returned as raw bytes and parsed by us at a fixed depth.
  maxRfc822NestingDepth: 0,
  maxNestingDepth: 20,
  maxHeadersSize: 256 * 1024,
  maxPartCount: 200,
} as const;

function isoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  // A local clock without a timezone is not evidence of an absolute event instant.
  if (
    value.length > 128 ||
    !/\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?\s*(?:Z|[+-]\d{2}:?\d{2}|UT|GMT|(?:E[SD]|C[SD]|M[SD]|P[SD])T)(?:\s*\([^)]{0,80}\))?\s*$/i.test(
      value,
    )
  )
    return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function toMessage(email: Email): ParsedMessage {
  if (
    (email.subject?.length ?? 0) > EML_LIMITS.maxSubjectChars ||
    (email.from?.name?.length ?? 0) > EML_LIMITS.maxNameChars ||
    (email.text?.length ?? 0) > EML_LIMITS.maxTextChars ||
    (email.html?.length ?? 0) > EML_LIMITS.maxHtmlChars
  )
    throw new EmlError("TOO_LARGE");
  const recipients = (email.to ?? []).flatMap((a) =>
    a.group ? a.group.map((g) => g.address) : [a.address],
  );
  const to = [
    ...new Set(
      recipients
        .filter((a): a is string => !!a)
        .map((a) => a.trim().toLowerCase()),
    ),
  ];
  if (to.length > EML_LIMITS.maxRecipients) throw new EmlError("TOO_MANY");
  const text = email.text?.trim()
    ? email.text
    : email.html
      ? htmlText(email.html)
      : "";
  // Never silently discard the tail: it may contain a secret or contradict an earlier phrase.
  if (text.length > EML_LIMITS.maxTextChars) throw new EmlError("TOO_LARGE");
  return {
    messageId: email.messageId?.trim() || null,
    fromName: email.from?.name?.trim() ?? "",
    fromAddress: email.from?.address?.trim().toLowerCase() || null,
    to,
    subject: email.subject?.trim() ?? "",
    date: originalDate(email),
    text,
  };
}

function originalDate(email: Email): string | null {
  const dates = email.headers.filter(
    (header) => header.key.toLowerCase() === "date",
  );
  return dates.length === 1 ? isoOrNull(dates[0]!.value) : null;
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

async function parseOne(bytes: Uint8Array): Promise<Email> {
  try {
    return await PostalMime.parse(bytes, PARSE_OPTIONS);
  } catch {
    throw new EmlError("MALFORMED");
  }
}

const looksLikeMessage = (m: ParsedMessage): boolean =>
  !!(m.fromAddress || m.subject || m.date || m.messageId);

/**
 * Parses an uploaded .eml. If it carries `message/rfc822` attachments (Gmail's "Forward as
 * attachment") each attached original becomes its own result and the envelope contributes only
 * its date. Otherwise the file itself is the original. Inline forwards are refused because their
 * headers and timestamps can be rewritten. Never recurses past one envelope.
 */
export async function parseEml(bytes: Uint8Array): Promise<ParsedOriginal[]> {
  if (bytes.byteLength === 0) throw new EmlError("EMPTY");
  if (bytes.byteLength > EML_LIMITS.maxBytes) throw new EmlError("TOO_LARGE");

  const outer = await parseOne(bytes);
  const attached = outer.attachments.filter(
    (a) => a.mimeType.toLowerCase() === "message/rfc822",
  );

  if (attached.length === 0) {
    const message = toMessage(outer);
    if (!looksLikeMessage(message)) throw new EmlError("NOT_A_MESSAGE");
    if (
      /^\s*(?:fwd?|fw)\s*:/i.test(message.subject) ||
      /-{2,}\s*forwarded message\s*-{2,}/i.test(message.text)
    ) {
      throw new EmlError("INLINE_FORWARD");
    }
    return [{ message, fingerprint: sha256(bytes), envelopeDate: null }];
  }

  if (attached.length > EML_LIMITS.maxOriginals) throw new EmlError("TOO_MANY");
  const envelopeDate = originalDate(outer);
  const results: ParsedOriginal[] = [];
  for (const attachment of attached) {
    const raw = new Uint8Array(attachment.content as ArrayBuffer);
    const message = toMessage(await parseOne(raw));
    if (!looksLikeMessage(message)) throw new EmlError("NOT_A_MESSAGE");
    results.push({ message, fingerprint: sha256(raw), envelopeDate });
  }
  return results;
}

/** Subjects are persisted for the evidence timeline, so strip anything token-shaped first. */
export function redactSubject(subject: string): string {
  return subject
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/\b\d{6,}\b/g, "[#]")
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, "[token]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}
