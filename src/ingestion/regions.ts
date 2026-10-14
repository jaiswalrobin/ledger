/** Transient markers inserted by the HTML scanner; never persisted as extracted facts. */
export const QUOTE_START = "\uE000";
export const QUOTE_END = "\uE001";

export interface MessageRegions {
  current: string;
  signature: string;
  hasQuotedHistory: boolean;
}

/** Preserve current assertions separately from quoted history and trailing signature text. */
export function messageRegions(text: string): MessageRegions {
  const current: string[] = [];
  const signature: string[] = [];
  let depth = 0;
  let history = false;
  let inSignature = false;
  let hasQuotedHistory = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.includes(QUOTE_START) || line.includes(QUOTE_END)) {
      for (const char of line) {
        if (char === QUOTE_START) depth += 1;
        if (char === QUOTE_END) depth = Math.max(0, depth - 1);
      }
      hasQuotedHistory = true;
      continue;
    }
    if (/^(?:On\s+.{1,250}\s+wrote:|[-_]{2,}\s*(?:Original Message|Forwarded message)\s*[-_]{2,})$/i.test(line)) {
      history = true;
      hasQuotedHistory = true;
    }
    if (history || depth || /^\s*>/.test(raw)) {
      hasQuotedHistory = true;
      continue;
    }
    if (/^(?:--|best(?: regards| wishes)?|kind regards|regards|sincerely|cheers|thanks)[,!]?$/.test(line.toLowerCase()))
      inSignature = true;
    (inSignature ? signature : current).push(raw);
  }
  return { current: current.join("\n"), signature: signature.join("\n"), hasQuotedHistory };
}
