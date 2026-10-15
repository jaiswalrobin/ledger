/** Scores the extractor against the labeled corpus: `npm run eval:parser [-- holdout]` */
import { scoreCorpus, type Field } from "../tests/corpus/score.ts";
import { CORPUS } from "../tests/corpus/emails.ts";
import { HOLDOUT } from "../tests/corpus/holdout.ts";
import { printFieldTable, printRuleTable } from "./eval-format.ts";

const set = process.argv[2] === "holdout" ? HOLDOUT : CORPUS;
const results = await scoreCorpus(set);
console.log(`\n${process.argv[2] === "holdout" ? "Held-out set" : "Corpus"}: ${results.length} emails\n`);
printFieldTable(results);
const failures = results.filter((r) => Object.values(r.verdicts).some((v) => v !== "correct"));
if (failures.length) console.log(`\nFailures (${failures.length}):`);
for (const r of failures) {
  console.log(`\n- ${r.email.id}: ${r.email.note}`);
  for (const f of ["kind", "company", "title"] as Field[])
    if (r.verdicts[f] !== "correct")
      console.log(`    ${f.padEnd(8)} ${r.verdicts[f].padEnd(9)} expected ${JSON.stringify(r.email.expect[f])}, got ${JSON.stringify(r.actual[f])}`);
}
printRuleTable(results);
