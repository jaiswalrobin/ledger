import { companyKey } from "../../src/domain/normalization.ts";
import { extractSignal } from "../../src/ingestion/extract.ts";
import { FIELD_RULES, type FieldRule } from "../../src/ingestion/fields.ts";
import { parseEml } from "../../src/ingestion/eml.ts";
import { buildEml } from "../helpers/eml.ts";
import type { ExtractedSignal } from "../../src/ingestion/source.ts";
import { CORPUS, type CorpusEmail } from "./emails.ts";

export type Field = "kind" | "company" | "title";
export type Verdict = "correct" | "missed" | "wrong" | "spurious";

const norm = (v: string | null | undefined) =>
  v == null
    ? null
    : v
        .normalize("NFKC")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[.,;:!]+$/, "");

/**
 * correct: matches the label (including both empty). missed: label has a value, extractor none.
 * wrong: both have values and they differ. spurious: label empty, extractor invented a value.
 */
export function verdict(
  expected: string | null,
  actual: string | null,
): Verdict {
  const e = norm(expected),
    a = norm(actual);
  if (e === a) return "correct";
  if (a == null) return "missed";
  if (e == null) return "spurious";
  return "wrong";
}

export type RuleField = "company" | "title";

/** Which extraction rules took part in one field of one email. */
export interface RuleTrace {
  /** Every rule that proposed any candidate. */
  fired: readonly FieldRule[];
  /** Rules behind the value the extractor emitted. */
  emitted: readonly FieldRule[];
  /** Rules that proposed the labelled value, whether or not it won. */
  expected: readonly FieldRule[];
}

export type Expected = Record<Field, string | null>;

/** One labelled email scored against the extractor's signal. */
export interface Scored {
  expect: Expected;
  actual: Record<Field, string | null>;
  verdicts: Record<Field, Verdict>;
  rules: Record<RuleField, RuleTrace>;
}

export interface CaseResult extends Scored {
  email: CorpusEmail;
}

function traceRules(
  field: RuleField,
  decision:
    | {
        candidates: readonly { value: string; rules?: readonly string[] }[];
        firedRules?: readonly string[];
      }
    | undefined,
  emitted: string | null,
  expected: string | null,
): RuleTrace {
  const same = (a: string, b: string | null) =>
    b != null &&
    (field === "company"
      ? companyKey(a) === companyKey(b)
      : norm(a) === norm(b));
  const candidates = decision?.candidates ?? [];
  const rulesOf = (keep: (value: string) => boolean) =>
    [
      ...new Set(
        candidates.filter((c) => keep(c.value)).flatMap((c) => c.rules ?? []),
      ),
    ].sort() as FieldRule[];
  return {
    // The candidate list keeps eight values; firedRules covers the ones cut.
    fired: decision?.firedRules
      ? ([...decision.firedRules].sort() as FieldRule[])
      : rulesOf(() => true),
    emitted: rulesOf((value) => same(value, emitted)),
    expected: rulesOf((value) => same(value, expected)),
  };
}

export function scoreSignal(expect: Expected, signal: ExtractedSignal): Scored {
  const actual = {
    kind: signal.kind,
    company: signal.fields.company,
    title: signal.fields.title,
  };
  const decisions = signal.fields.fieldDecisions;
  return {
    expect,
    actual,
    rules: {
      company: traceRules(
        "company",
        decisions?.company,
        actual.company,
        expect.company,
      ),
      title: traceRules("title", decisions?.title, actual.title, expect.title),
    },
    verdicts: {
      kind: verdict(expect.kind, actual.kind),
      company: verdict(expect.company, actual.company),
      title: verdict(expect.title, actual.title),
    },
  };
}

export async function scoreCorpus(
  emails: readonly CorpusEmail[] = CORPUS,
): Promise<CaseResult[]> {
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
    results.push({
      email,
      ...scoreSignal(email.expect, extractSignal(original!.message)),
    });
  }
  return results;
}

export function summarize(
  results: readonly Pick<Scored, "expect" | "actual" | "verdicts">[],
) {
  const fields: Field[] = ["kind", "company", "title"];
  return Object.fromEntries(
    fields.map((f) => {
      const counts = { correct: 0, missed: 0, wrong: 0, spurious: 0 };
      for (const r of results) counts[r.verdicts[f]] += 1;
      const support = results.filter((r) => r.expect[f] != null).length;
      const emitted = results.filter((r) => r.actual[f] != null).length;
      const recovered = results.filter(
        (r) => r.expect[f] != null && r.verdicts[f] === "correct",
      ).length;
      return [
        f,
        {
          ...counts,
          support,
          emitted,
          recovered,
          accuracy: results.length ? counts.correct / results.length : 0,
          precision: emitted ? recovered / emitted : null,
          recall: support ? recovered / support : null,
          coverage: results.length ? emitted / results.length : 0,
        },
      ];
    }),
  ) as Record<
    Field,
    {
      correct: number;
      missed: number;
      wrong: number;
      spurious: number;
      accuracy: number;
      support: number;
      emitted: number;
      recovered: number;
      precision: number | null;
      recall: number | null;
      coverage: number;
    }
  >;
}

export interface RuleStats {
  /** Emails in which the rule proposed any candidate. */
  fired: number;
  /** Emails in which it backed the emitted value, and that value was right. */
  correct: number;
  /** Emails in which it backed the emitted value, and that value was wrong or invented. */
  wrong: number;
  /** Emails in which it proposed the labelled value, but the extractor emitted another or none. */
  lost: number;
}

/** Per-rule attribution over both fields: which rules earn their place, and which never fire. */
export function ruleReport(results: readonly Scored[]): {
  stats: Map<FieldRule, RuleStats>;
  unfired: FieldRule[];
} {
  const stats = new Map<FieldRule, RuleStats>(
    FIELD_RULES.map((rule) => [
      rule,
      { fired: 0, correct: 0, wrong: 0, lost: 0 },
    ]),
  );
  for (const result of results)
    for (const field of ["company", "title"] as const) {
      const trace = result.rules[field];
      const verdict = result.verdicts[field];
      for (const rule of trace.fired) stats.get(rule)!.fired++;
      for (const rule of trace.emitted)
        stats.get(rule)![verdict === "correct" ? "correct" : "wrong"]++;
      if (verdict === "missed" || verdict === "wrong")
        for (const rule of trace.expected) stats.get(rule)!.lost++;
    }
  return {
    stats,
    unfired: FIELD_RULES.filter((rule) => stats.get(rule)!.fired === 0),
  };
}
