/** Scores the extractor against the labeled corpus: `node --experimental-strip-types scripts/parser-eval.ts` */
import { ruleReport, scoreCorpus, summarize, type Field } from "../tests/corpus/score.ts";
import { CORPUS } from "../tests/corpus/emails.ts";
import { HOLDOUT } from "../tests/corpus/holdout.ts";

const set = process.argv[2] === "holdout" ? HOLDOUT : CORPUS;
const results = await scoreCorpus(set);
const summary = summarize(results);
console.log(`\n${process.argv[2] === "holdout" ? "Held-out set" : "Corpus"}: ${results.length} emails\n`);
console.log("field     accuracy  precision  recall  coverage  support  correct  missed  wrong  spurious");
const percent = (value: number | null) => value === null ? "   n/a" : `${(value * 100).toFixed(1)}%`.padStart(6);
for (const [field, s] of Object.entries(summary))
  console.log(`${field.padEnd(9)} ${percent(s.accuracy)}  ${percent(s.precision).padStart(9)}  ${percent(s.recall)}  ${percent(s.coverage).padStart(8)}  ${String(s.support).padStart(7)}  ${String(s.correct).padStart(7)}  ${String(s.missed).padStart(6)}  ${String(s.wrong).padStart(5)}  ${String(s.spurious).padStart(8)}`);
const failures = results.filter((r) => Object.values(r.verdicts).some((v) => v !== "correct"));
if (failures.length) console.log(`\nFailures (${failures.length}):`);
for (const r of failures) {
  console.log(`\n- ${r.email.id}: ${r.email.note}`);
  for (const f of ["kind", "company", "title"] as Field[])
    if (r.verdicts[f] !== "correct")
      console.log(`    ${f.padEnd(8)} ${r.verdicts[f].padEnd(9)} expected ${JSON.stringify(r.email.expect[f])}, got ${JSON.stringify(r.actual[f])}`);
}

// Which company/title rules produced the values. A rule that backs wrong values, or only ever
// loses, is a candidate for tightening; one that never fires has no example in this set.
const { stats, unfired } = ruleReport(results);
const fired = [...stats].filter(([, s]) => s.fired > 0).sort(([a, x], [b, y]) => y.wrong - x.wrong || y.fired - x.fired || a.localeCompare(b));
console.log(`\nRules: ${fired.length} of ${stats.size} fired\n`);
console.log("rule                        fired  correct  wrong  lost");
for (const [rule, s] of fired)
  console.log(`${rule.padEnd(26)} ${String(s.fired).padStart(6)}  ${String(s.correct).padStart(7)}  ${String(s.wrong).padStart(5)}  ${String(s.lost).padStart(4)}`);
if (unfired.length) console.log(`\nNever fired: ${unfired.join(", ")}`);
