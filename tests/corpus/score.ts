import { extractSignal } from "../../src/ingestion/extract.ts";
import { parseEml } from "../../src/ingestion/eml.ts";
import { buildEml } from "../helpers/eml.ts";
import { CORPUS, type CorpusEmail } from "./emails.ts";

export type Field = "kind" | "company" | "title";
export type Verdict = "correct" | "missed" | "wrong" | "spurious";

const norm = (v: string | null | undefined) =>
  v == null ? null : v.toLowerCase().replace(/\s+/g, " ").replace(/[.,;:!]+$/, "").trim();

/**
 * correct: matches the label (including both empty). missed: label has a value, extractor none.
 * wrong: both have values and they differ. spurious: label empty, extractor invented a value.
 */
export function verdict(expected: string | null, actual: string | null): Verdict {
  const e = norm(expected), a = norm(actual);
  if (e === a) return "correct";
  if (a == null) return "missed";
  if (e == null) return "spurious";
  return "wrong";
}

export interface CaseResult {
  email: CorpusEmail;
  actual: Record<Field, string | null>;
  verdicts: Record<Field, Verdict>;
}

export async function scoreCorpus(emails: readonly CorpusEmail[] = CORPUS): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const email of emails) {
    const raw = buildEml({
      from: email.from,
      to: "robin.example@example.com",
      subject: email.subject,
      date: "Mon, 12 Oct 2026 09:30:00 +0000",
      messageId: `<${email.id}@corpus.example>`,
      text: email.text ?? "",
      ...(email.html !== undefined ? { html: email.html } : {}),
    });
    const [original] = await parseEml(new TextEncoder().encode(raw));
    const signal = extractSignal(original!.message);
    const actual = { kind: signal.kind, company: signal.fields.company, title: signal.fields.title };
    results.push({
      email,
      actual,
      verdicts: {
        kind: verdict(email.expect.kind, actual.kind),
        company: verdict(email.expect.company, actual.company),
        title: verdict(email.expect.title, actual.title),
      },
    });
  }
  return results;
}

export function summarize(results: CaseResult[]) {
  const fields: Field[] = ["kind", "company", "title"];
  return Object.fromEntries(
    fields.map((f) => {
      const counts = { correct: 0, missed: 0, wrong: 0, spurious: 0 };
      for (const r of results) counts[r.verdicts[f]] += 1;
      return [f, { ...counts, accuracy: counts.correct / results.length }];
    }),
  ) as Record<Field, { correct: number; missed: number; wrong: number; spurious: number; accuracy: number }>;
}
