import { QUOTE_START, QUOTE_END } from "./regions.ts";

/** A bounded, single-pass text scanner. No rendering, DOM execution, or resource loading. */
export class HtmlInspectionError extends Error {
  constructor() {
    super("MALFORMED_HTML");
  }
}
/** Block-level closers that end a visual line, so "Label: value" rows stay on their own line. */
const BLOCKS = new Set([
  "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "ul", "ol",
  "section", "article", "header", "footer", "blockquote", "center", "dd", "dt", "pre",
]);

/** Entities ATS templates actually use. Typographic quotes matter: "we&rsquo;d like to offer". */
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c",
  sbquo: "\u201a", bdquo: "\u201e", prime: "\u2032",
  ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", middot: "\u00b7",
  bull: "\u2022", copy: "\u00a9", reg: "\u00ae", trade: "\u2122",
  ensp: " ", emsp: " ", thinsp: " ", zwnj: "", zwj: "", shy: "",
  laquo: "\u00ab", raquo: "\u00bb", euro: "\u20ac", pound: "\u00a3",
  eacute: "\u00e9", egrave: "\u00e8", aacute: "\u00e1", agrave: "\u00e0",
  oacute: "\u00f3", uuml: "\u00fc", ouml: "\u00f6", auml: "\u00e4",
  ccedil: "\u00e7", ntilde: "\u00f1", szlig: "\u00df",
};

export function htmlText(html: string): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  const links: (string | null)[] = [];
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf("<", i);
    if (open < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, open));
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    const end = html.indexOf(">", open + 1);
    if (end < 0) break;
    if (end - open > 4096) {
      i = end + 1;
      continue;
    }
    const tag = html.slice(open + 1, end);
    const name = /^\s*(\/?)([a-z][a-z0-9]*)\b/i.exec(tag);
    i = end + 1;
    if (!name) continue;
    const closing = !!name[1];
    const kind = name[2]!.toLowerCase();
    if (kind === "blockquote") {
      out.push(`\n${closing ? QUOTE_END : QUOTE_START}\n`);
      continue;
    }
    if (!closing && ["script", "style", "head"].includes(kind)) {
      let close = lower.indexOf(`</${kind}`, i);
      while (
        close >= 0 &&
        /[a-z0-9]/.test(lower[close + kind.length + 2] ?? "")
      )
        close = lower.indexOf(`</${kind}`, close + kind.length + 2);
      // Many templates never close <head>; dropping everything after it would erase the body.
      if (close < 0 && kind === "head") {
        out.push(" ");
        continue;
      }
      if (close < 0) break;
      const finish = html.indexOf(">", close);
      if (finish < 0) break;
      i = finish + 1;
      out.push(" ");
      continue;
    }
    if (kind === "a") {
      if (closing) {
        const href = links.pop();
        if (href) out.push(` (${href}) `);
      } else {
        if (links.length >= 20) throw new HtmlInspectionError();
        const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
          tag,
        );
        const href = match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
        links.push(href && href.length <= 2048 ? href : null);
      }
    }
    if (kind === "br" || kind === "hr" || (closing && BLOCKS.has(kind)))
      out.push("\n");
    else out.push(" ");
  }
  return out
    .join("")
    .replace(
      /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]{1,9}));/gi,
      (m, dec: string, hex: string, name: string) => {
        const value = dec ? Number(dec) : hex ? parseInt(hex, 16) : NaN;
        if (Number.isFinite(value))
          return value <= 0x10ffff && value > 0
            ? String.fromCodePoint(value)
            : " ";
        return ENTITIES[name] ?? ENTITIES[name?.toLowerCase()] ?? m;
      },
    )
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
