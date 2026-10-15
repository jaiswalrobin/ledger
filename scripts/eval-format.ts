/** Console tables shared by the parser evaluations. Output names fields and rules only. */
import { ruleReport, summarize, type Scored } from "../tests/corpus/score.ts";

const percent = (value: number | null) =>
  value === null ? "   n/a" : `${(value * 100).toFixed(1)}%`.padStart(6);

export function printFieldTable(results: readonly Scored[]): void {
  console.log(
    "field     accuracy  precision  recall  coverage  support  correct  missed  wrong  spurious",
  );
  for (const [field, s] of Object.entries(summarize(results)))
    console.log(
      `${field.padEnd(9)} ${percent(s.accuracy)}  ${percent(s.precision).padStart(9)}  ${percent(s.recall)}  ${percent(s.coverage).padStart(8)}  ${String(s.support).padStart(7)}  ${String(s.correct).padStart(7)}  ${String(s.missed).padStart(6)}  ${String(s.wrong).padStart(5)}  ${String(s.spurious).padStart(8)}`,
    );
}

/**
 * Which company/title rules produced the values, counted per email field. A rule that backs wrong
 * values, or only ever loses, is a candidate for tightening; one that never fires has no example.
 */
export function printRuleTable(
  results: readonly Scored[],
  { onlyProblems = false } = {},
): void {
  const { stats, unfired } = ruleReport(results);
  const fired = [...stats]
    .filter(
      ([, s]) => s.fired > 0 && (!onlyProblems || s.wrong > 0 || s.lost > 0),
    )
    .sort(
      ([a, x], [b, y]) =>
        y.wrong - x.wrong ||
        y.lost - x.lost ||
        y.fired - x.fired ||
        a.localeCompare(b),
    );
  console.log(
    `\nRules: ${stats.size - unfired.length} of ${stats.size} fired${onlyProblems ? "; showing those with wrong or lost values" : ""}\n`,
  );
  if (fired.length)
    console.log("rule                        fired  correct  wrong  lost");
  for (const [rule, s] of fired)
    console.log(
      `${rule.padEnd(26)} ${String(s.fired).padStart(6)}  ${String(s.correct).padStart(7)}  ${String(s.wrong).padStart(5)}  ${String(s.lost).padStart(4)}`,
    );
  if (unfired.length && !onlyProblems)
    console.log(`\nNever fired: ${unfired.join(", ")}`);
}
