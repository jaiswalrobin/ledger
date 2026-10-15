/** Builds RFC 822 messages for tests. Everything here is synthetic (example.com style data). */
export interface Attachment {
  filename: string;
  mime: string;
  content: string;
}

export interface EmlSpec {
  from: string;
  to: string | string[];
  subject: string;
  date?: string | null;
  messageId?: string | null;
  text?: string;
  html?: string;
  attachments?: Attachment[];
}

const CRLF = "\r\n";

function wrap76(base64: string): string {
  return base64.replace(/(.{76})/g, "$1" + CRLF);
}

export function buildEml(spec: EmlSpec): string {
  const headers: string[] = [
    "From: " + spec.from,
    "To: " + (Array.isArray(spec.to) ? spec.to.join(", ") : spec.to),
    "Subject: " + spec.subject,
  ];
  if (spec.date !== null)
    headers.push("Date: " + (spec.date ?? "Mon, 05 Oct 2026 09:30:00 +0000"));
  if (spec.messageId !== null)
    headers.push(
      "Message-ID: " +
        (spec.messageId ??
          "<" + Math.random().toString(36).slice(2) + "@mail.example.com>"),
    );
  headers.push("MIME-Version: 1.0");

  const text = spec.text ?? "";
  if (spec.attachments?.length) {
    const boundary = "mix-" + Math.random().toString(36).slice(2);
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      text,
    ];
    for (const a of spec.attachments) {
      parts.push(
        `--${boundary}`,
        `Content-Type: ${a.mime}; name="${a.filename}"`,
        `Content-Disposition: attachment; filename="${a.filename}"`,
        "Content-Transfer-Encoding: base64",
        "",
        wrap76(Buffer.from(a.content, "utf8").toString("base64")),
      );
    }
    parts.push(`--${boundary}--`, "");
    return headers.join(CRLF) + CRLF + CRLF + parts.join(CRLF);
  }
  if (spec.html !== undefined) {
    const boundary = "alt-" + Math.random().toString(36).slice(2);
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const parts = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      text,
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      spec.html,
      `--${boundary}--`,
      "",
    ];
    return headers.join(CRLF) + CRLF + CRLF + parts.join(CRLF);
  }
  headers.push("Content-Type: text/plain; charset=utf-8");
  return headers.join(CRLF) + CRLF + CRLF + text + CRLF;
}

/** A "Forward as attachment" envelope: the original is carried as message/rfc822. */
export function forwardAsAttachment(
  originals: string[],
  opts: { from?: string; to?: string; date?: string; subject?: string } = {},
): string {
  return buildEml({
    from: opts.from ?? "Me <me@personal.example.com>",
    to: opts.to ?? "Jobs <jobs@example.org>",
    subject: opts.subject ?? "Fwd: job emails",
    date: opts.date ?? "Fri, 09 Oct 2026 18:00:00 +0000",
    text: "Forwarding for tracking.",
    attachments: originals.map((content, i) => ({
      filename: `original-${i + 1}.eml`,
      mime: "message/rfc822",
      content,
    })),
  });
}
