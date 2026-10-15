import assert from "node:assert/strict";
import { it } from "node:test";
import { extractSignal } from "../src/ingestion/extract.ts";
import {
  extractCompanyAndTitle,
  FIELD_RULES,
  type FieldRule,
} from "../src/ingestion/fields.ts";
import type { ParsedMessage } from "../src/ingestion/source.ts";
import { CORPUS } from "./corpus/emails.ts";
import { HOLDOUT } from "./corpus/holdout.ts";
import { ruleReport, scoreCorpus } from "./corpus/score.ts";

const base: ParsedMessage = {
  messageId: "<rule-example@example.com>",
  fromName: "",
  fromAddress: null,
  to: [],
  subject: "",
  date: "2026-10-12T09:30:00Z",
  text: "",
};

const invitation = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:rule-example@example.com",
  "SEQUENCE:0",
  "DTSTAMP:20261012T093000Z",
  "DTSTART:20261021T100000Z",
  "SUMMARY:Technical Interview - Backend Engineer",
  "DESCRIPTION:Interview for the Backend Engineer role at Acme.",
  "ORGANIZER:mailto:recruiting@acme.example",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

/**
 * Rules the scored corpus cannot exercise (it carries no calendar parts) or has no email for yet,
 * each with the smallest message that shows the rule and the value it must produce.
 */
const EXAMPLES: {
  rule: FieldRule;
  field: "company" | "title";
  value: string;
  message: Partial<ParsedMessage>;
}[] = [
  {
    rule: "hint:calendar",
    field: "title",
    value: "Backend Engineer",
    message: {
      fromName: "Acme Careers",
      fromAddress: "careers@acme.example",
      subject: "Interview invitation",
      text: "Please find the invitation attached.",
      calendarParts: [{ method: "REQUEST", content: invitation }],
    },
  },
  {
    rule: "hint:workday-slug",
    field: "title",
    value: "Data Engineer",
    message: {
      fromName: "Acme",
      fromAddress: "acme@myworkday.com",
      subject: "Application received",
      text: "We have received your application.\nhttps://acme.wd5.myworkdayjobs.com/en-US/External/job/Remote/Data-Engineer_R12345",
    },
  },
  {
    rule: "subject:update-on",
    field: "company",
    value: "Initech",
    message: {
      fromName: "Careers",
      fromAddress: "no-reply@greenhouse.io",
      subject: "Update on your Initech application",
      text: "Unfortunately we will not be moving forward with your application for the Backend Engineer role.",
    },
  },
  {
    rule: "subject:domain-phrase",
    field: "company",
    value: "Massive Dynamic",
    message: {
      fromName: "Recruiting",
      fromAddress: "jobs@massivedynamic.com",
      subject: "Massive Dynamic next steps",
      text: "Thank you for applying for the Backend Engineer position. We have received your application.",
    },
  },
];

it("each example produces its value through its rule", () => {
  for (const example of EXAMPLES) {
    const signal = extractSignal({ ...base, ...example.message });
    assert.equal(signal.fields[example.field], example.value, example.rule);
    const winner = signal.fields.fieldDecisions![example.field].candidates.find(
      (c) => c.value === example.value,
    );
    assert.ok(
      winner?.rules?.includes(example.rule),
      `${example.rule} backs ${example.value}`,
    );
  }
});

it("every company/title rule fires on the labelled sets or on a named example, and backs no wrong value", async () => {
  const { stats } = ruleReport([
    ...(await scoreCorpus(CORPUS)),
    ...(await scoreCorpus(HOLDOUT)),
  ]);
  const exemplified = new Set(EXAMPLES.map((example) => example.rule));
  // A new rule needs an email in the corpus, or an example above, before it can merge.
  assert.deepEqual(
    FIELD_RULES.filter(
      (rule) => stats.get(rule)!.fired === 0 && !exemplified.has(rule),
    ),
    [],
  );
  assert.deepEqual(
    [...stats].filter(([, s]) => s.wrong > 0).map(([rule]) => rule),
    [],
  );
});

it("records every fired rule even when candidates beyond the eighth are dropped", () => {
  const titles = [
    "Backend Engineer",
    "Frontend Engineer",
    "Data Engineer",
    "Platform Engineer",
    "Security Engineer",
    "Mobile Engineer",
    "Site Reliability Engineer",
    "Machine Learning Engineer",
    "Product Designer",
  ];
  const { decisions } = extractCompanyAndTitle({
    subject: "",
    fromName: "",
    fromAddress: null,
    body: "",
    titleHints: [
      ...titles.map((value) => ({
        value,
        weight: 3,
        rule: "hint:calendar" as const,
      })),
      { value: "Data Analyst", weight: 1, rule: "hint:workday-slug" as const },
    ],
  });
  assert.equal(decisions.title.candidates.length, 8);
  assert.ok(
    !decisions.title.candidates.some((c) =>
      c.rules?.includes("hint:workday-slug"),
    ),
  );
  assert.deepEqual(decisions.title.firedRules, [
    "hint:calendar",
    "hint:workday-slug",
  ]);
});
