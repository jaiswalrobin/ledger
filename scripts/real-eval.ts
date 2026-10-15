/**
 * Evaluates Ledger on your own mail, locally: `npm run eval:real -- label` then `npm run eval:real`.
 * See docs/real-mail-evaluation.md. Emails and labels stay in a git-ignored folder (eval/real).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  evaluateReal,
  labelEmails,
  type Judgement,
} from "../tests/corpus/real.ts";
import type { Field } from "../tests/corpus/score.ts";
import { printFieldTable, printRuleTable } from "./eval-format.ts";

const args = process.argv.slice(2);
const dirFlag = args.indexOf("--dir");
const dir = resolve(dirFlag >= 0 ? (args[dirFlag + 1] ?? "") : "eval/real");
const mode =
  args.find(
    (arg, i) => !arg.startsWith("--") && (dirFlag < 0 || i !== dirFlag + 1),
  ) ?? "score";

/** Labels describe private mail: never write them where git would pick them up. */
function ensureIgnored(): void {
  try {
    execFileSync("git", ["check-ignore", "-q", join(dir, "labels.json")], {
      stdio: "ignore",
    });
  } catch (error) {
    // 1: inside the repository and not ignored. 128: outside any repository, which is fine.
    if ((error as { status?: number }).status === 1) {
      console.error(
        `REFUSED: ${dir} is not git-ignored. Keep real mail in eval/real/ or outside the repository.`,
      );
      process.exit(1);
    }
  }
}

const count = (judgement: Judgement, outcomes: { judgement: Judgement }[]) =>
  outcomes.filter((o) => o.judgement === judgement).length;

if (!existsSync(dir)) {
  console.error(
    `No folder ${dir}. Create it and add .eml files downloaded from Gmail (see docs/real-mail-evaluation.md).`,
  );
  process.exitCode = 1;
} else if (mode === "label") {
  ensureIgnored();
  const { added, unverified, unreadable } = await labelEmails(dir);
  console.log(
    `Added ${added.length} pre-filled label(s) to ${join(dir, "labels.json")}.`,
  );
  console.log(
    `${unverified} label(s) are unverified: check kind, company and title, then set "verified": true.`,
  );
  if (unreadable.length) console.log(`Unreadable: ${unreadable.join(", ")}`);
} else if (mode === "score") {
  const report = await evaluateReal(dir);
  console.log(
    `\nReal mail: ${report.emails} emails, ${report.verified} with verified labels`,
  );
  if (report.unreadable.length)
    console.log(`Unreadable: ${report.unreadable.join(", ")}`);
  if (!report.verified) {
    console.log(
      "Nothing to score yet: run `npm run eval:real -- label` and verify some labels.",
    );
  } else {
    console.log("\nExtraction\n");
    printFieldTable(report.extraction);
    printRuleTable(report.extraction, { onlyProblems: true });
    const failures = report.extraction.filter((r) =>
      Object.values(r.verdicts).some((v) => v !== "correct"),
    );
    for (const r of failures)
      for (const f of ["kind", "company", "title"] as Field[])
        if (r.verdicts[f] !== "correct")
          console.log(
            `  ${r.file}  ${f} ${r.verdicts[f]}: expected ${JSON.stringify(r.expect[f])}, got ${JSON.stringify(r.actual[f])}`,
          );

    const { outcomes } = report;
    const hiring = outcomes.filter((o) => o.label.kind);
    const share = (n: number) =>
      hiring.length
        ? ` (${((n / hiring.length) * 100).toFixed(0)}% of hiring mail)`
        : "";
    console.log("\nPipeline, after every email was processed in date order\n");
    console.log(
      `  applied correctly  ${String(count("applied-correctly", outcomes)).padStart(5)}${share(count("applied-correctly", outcomes))}`,
    );
    console.log(
      `  APPLIED WRONGLY    ${String(count("applied-wrongly", outcomes)).padStart(5)}   must be 0`,
    );
    console.log(
      `  waiting in review  ${String(count("review", outcomes)).padStart(5)}${share(count("review", outcomes))}`,
    );
    console.log(
      `  lost hiring mail   ${String(count("lost", outcomes)).padStart(5)}${share(count("lost", outcomes))}`,
    );
    console.log(
      `  review noise       ${String(count("review-noise", outcomes)).padStart(5)}   non-hiring mail sent to review`,
    );
    console.log(
      `  ignored            ${String(count("ignored", outcomes)).padStart(5)}`,
    );
    console.log(
      `  duplicate          ${String(count("duplicate", outcomes)).padStart(5)}`,
    );
    if (count("error", outcomes))
      console.log(
        `  errors             ${String(count("error", outcomes)).padStart(5)}`,
      );

    const reasons = new Map<string, number>();
    for (const o of outcomes)
      if (o.state.status === "REVIEW")
        reasons.set(o.state.reason, (reasons.get(o.state.reason) ?? 0) + 1);
    if (reasons.size)
      console.log(
        `\nReview reasons: ${[...reasons]
          .sort(([, a], [, b]) => b - a)
          .map(([r, n]) => `${r} ${n}`)
          .join(", ")}`,
      );

    const problems = outcomes.filter((o) =>
      ["applied-wrongly", "lost", "error"].includes(o.judgement),
    );
    if (problems.length) console.log("\nProblems:");
    for (const o of problems) {
      const label = `${o.label.kind ?? "not hiring"} ${o.label.company ?? "?"} / ${o.label.title ?? "?"}`;
      const got =
        o.state.status === "APPLIED"
          ? o.state.events
              .map((e) => `${e.kind} ${e.company} / ${e.title}`)
              .join("; ")
          : o.state.status;
      console.log(
        `  ${o.judgement.padEnd(15)} ${o.file}: label ${label}; got ${got}`,
      );
    }
    if (count("applied-wrongly", outcomes)) process.exitCode = 1;
  }
} else {
  console.error("Usage: npm run eval:real -- [label|score] [--dir eval/real]");
  process.exitCode = 1;
}
