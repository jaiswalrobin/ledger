/** Transient markers inserted by the HTML scanner; never persisted as extracted facts. */
export const QUOTE_START = "\uE000";
export const QUOTE_END = "\uE001";

export interface MessageRegions {
  current: string;
  signature: string;
  hasQuotedHistory: boolean;
}

const SIGN_OFF =
  /^(?:--|best(?: regards| wishes)?|kind regards|regards|sincerely|cheers|thanks)[,!]?$/i;
const METADATA =
  /^(?:(?:job\s*title|role|position|company|employer|location|application\s*(?:id|number|reference)|submitted email|applicant email|email used to apply)\s*[:\-–]|https?:\/\/|p\.?s\.?\s*:)/i;
const ASSERTION =
  /\b(?:received|submitted|applying|apply|invite|invited|confirm(?:ed)?|scheduled|rescheduled|offer|rejected|unfortunately|regret|please|we|your application)\b/i;

/** Preserve current assertions separately from quoted history and trailing signature text. */
export function messageRegions(text: string): MessageRegions {
  const current: string[] = [];
  const signature: string[] = [];
  let depth = 0;
  let history = false;
  let inSignature = false;
  let hasQuotedHistory = false;
  // Attribution headers are frequently wrapped by mail clients. Join only a bounded header,
  // never arbitrary body paragraphs, and leave the following quotation structurally intact.
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^On\s+/i.test(lines[i]!.trim())) continue;
    let header = lines[i]!.trim();
    for (
      let j = i + 1;
      !/wrote:\s*$/i.test(header) && j < Math.min(i + 4, lines.length);
      j++
    ) {
      if (!lines[j]!.trim() || header.length + lines[j]!.length > 250) break;
      header += " " + lines[j]!.trim();
      if (/wrote:\s*$/i.test(header)) {
        lines[i] = header;
        lines.fill("", i + 1, j + 1);
      }
    }
  }
  let signatureLines = 0;
  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i]!;
    // Preserve authored siblings before/after inline quote markers.
    if (raw.includes(QUOTE_START) || raw.includes(QUOTE_END)) {
      let authored = "";
      for (const char of raw) {
        if (char === QUOTE_START) {
          depth++;
          hasQuotedHistory = true;
        } else if (char === QUOTE_END) {
          depth = Math.max(0, depth - 1);
          hasQuotedHistory = true;
        } else if (!depth) authored += char;
      }
      raw = authored;
    }
    const line = raw.trim();
    if (
      /^(?:On\s+.{1,250}\s+wrote:|[-_]{2,}\s*(?:Original Message|Forwarded message)\s*[-_]{2,})$/i.test(
        line,
      )
    ) {
      // Prefix-quoted replies have an explicit end: subsequent unprefixed text is authored.
      // Unprefixed forwarded history has no reliable end and remains excluded conservatively.
      const next = lines.slice(i + 1).find((value) => value.trim());
      history = !next || !/^\s*>/.test(next);
      hasQuotedHistory = true;
      continue;
    }
    if (history || depth || /^\s*>/.test(raw)) {
      hasQuotedHistory = true;
      continue;
    }
    if (
      METADATA.test(line) ||
      (inSignature &&
        ASSERTION.test(line) &&
        /[.!?]|\b(?:we|your|please)\b/i.test(line))
    ) {
      inSignature = false;
      signatureLines = 0;
    }
    if (SIGN_OFF.test(line)) {
      const following = lines
        .slice(i + 1)
        .filter((value) => value.trim() && !/^\s*>/.test(value));
      const beginsBody = following
        .slice(0, 3)
        .some(
          (value) =>
            ASSERTION.test(value) &&
            /[.!?]|\b(?:we|your|please)\b/i.test(value),
        );
      inSignature = !beginsBody;
      signatureLines = 0;
    }
    if (inSignature && line && ++signatureLines > 4) inSignature = false;
    (inSignature ? signature : current).push(raw);
  }
  return {
    current: current.join("\n"),
    signature: signature.join("\n"),
    hasQuotedHistory,
  };
}
