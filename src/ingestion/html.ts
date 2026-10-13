/** A bounded, single-pass text scanner. No rendering, DOM execution, or resource loading. */
export class HtmlInspectionError extends Error {
  constructor() {
    super("MALFORMED_HTML");
  }
}
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
    if (!closing && ["script", "style", "head"].includes(kind)) {
      let close = lower.indexOf(`</${kind}`, i);
      while (
        close >= 0 &&
        /[a-z0-9]/.test(lower[close + kind.length + 2] ?? "")
      )
        close = lower.indexOf(`</${kind}`, close + kind.length + 2);
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
    if (
      kind === "br" ||
      (closing &&
        ["p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6"].includes(
          kind,
        ))
    )
      out.push("\n");
    else out.push(" ");
  }
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return out
    .join("")
    .replace(
      /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{1,10}));/gi,
      (m, dec: string, hex: string, name: string) => {
        const value = dec ? Number(dec) : hex ? parseInt(hex, 16) : NaN;
        if (Number.isFinite(value))
          return value <= 0x10ffff && value > 0
            ? String.fromCodePoint(value)
            : " ";
        return entities[name?.toLowerCase()] ?? m;
      },
    )
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
