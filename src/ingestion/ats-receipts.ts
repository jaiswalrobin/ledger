import { senderDomain } from "./ats.ts";
import type { AtsKey } from "../domain/types.ts";
import type { FieldRule } from "./fields.ts";

/** Provider detection grants no sender trust or authority to apply an event. */
export const ATS_RECEIPT_ADAPTERS = [
  {
    provider: "greenhouse",
    version: 1,
    domains: ["greenhouse.io", "greenhouse-mail.io"],
  },
  { provider: "lever", version: 1, domains: ["lever.co"] },
  {
    provider: "workday",
    version: 1,
    domains: ["myworkday.com", "myworkdayjobs.com"],
  },
  { provider: "ashby", version: 1, domains: ["ashbyhq.com"] },
  { provider: "smartrecruiters", version: 1, domains: ["smartrecruiters.com"] },
  { provider: "icims", version: 1, domains: ["icims.com"] },
  {
    provider: "workable",
    version: 1,
    domains: ["workable.com", "workablemail.com"],
  },
] as const;

export interface AtsReceiptHints {
  provider: (typeof ATS_RECEIPT_ADAPTERS)[number]["provider"] | null;
  titles: { value: string; weight: number; rule: FieldRule; labelled: true }[];
  companies: {
    value: string;
    weight: number;
    rule: FieldRule;
    labelled: true;
  }[];
  limited: boolean;
}

const TITLE_LABEL =
  /^(?:job(?:\s+(?:title|position|applied for|posting))?|position(?:\s+(?:title|applied for))?|role(?:\s+applied for)?|applied (?:position|role))$/i;
const COMPANY_LABEL =
  /^(?:company(?: name)?|employer(?: name)?|hiring company|organi[sz]ation)$/i;
const OTHER_LABEL =
  /^(?:company(?: name)?|employer(?: name)?|hiring company|organi[sz]ation|job title|position(?: title)?|role|location|job location|requisition(?: id)?|candidate(?: id)?|application(?: id)?|department|business unit|employment type|team|view (?:application|job)|privacy policy|unsubscribe)(?:\s*:|\s|$)/i;
const CLASSIC_LABEL =
  /^(?:job\s*title|position(?:\s*title)?|role|title|job|company|employer|organi[sz]ation)$/i;
const EMPTY_VALUE =
  /^(?:n\/?a|none|unknown|unspecified|not (?:provided|specified|available|applicable)|tbd|to be (?:determined|confirmed)|[-–—]+)[.!]?$/i;
const NAVIGATION =
  /^(?:(?:view|see|browse|explore|manage|edit|check) (?:the |your )?(?:job|role|posting|position|opening|application|status|details)|apply now|learn more|click here|unsubscribe|update (?:profile|preferences))\b/i;

/**
 * A first adapter recipe shared by the supported platforms: explicit receipt fields, including
 * split lines and labelled job anchors. Never infer a role from a bare link, tenant, footer, or
 * neighbouring heading. Input must already exclude quoted history and signatures.
 */
export function atsReceiptHints(input: {
  fromAddress: string | null;
  body: string;
  confirmed: boolean;
  jobKey: AtsKey | null;
  isPublicJobUrl: (url: string) => boolean;
}): AtsReceiptHints {
  const domain = senderDomain(input.fromAddress ?? "");
  const bySender = ATS_RECEIPT_ADAPTERS.find((a) =>
    a.domains.some((d) => domain === d || domain.endsWith(`.${d}`)),
  );
  const byJob = ATS_RECEIPT_ADAPTERS.find(
    (a) => a.provider === input.jobKey?.provider,
  );
  const adapter = bySender ?? byJob;
  const result: AtsReceiptHints = {
    provider: adapter?.provider ?? null,
    titles: [],
    companies: [],
    limited: false,
  };
  if (
    !adapter ||
    !input.confirmed ||
    (bySender && byJob && bySender.provider !== byJob.provider)
  )
    return result;
  const lines = input.body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const inline = /^(.{2,40}?)\s*:\s*(.{1,230})$/.exec(line);
    const label = (inline?.[1] ?? line.replace(/:$/, "")).trim();
    const title = TITLE_LABEL.test(label),
      company = COMPANY_LABEL.test(label);
    if (!title && !company) continue;
    let value = inline?.[2]?.trim();
    if (!value) {
      // Only the immediately following field value, allowing one empty layout line.
      let next = i + 1;
      if (lines[next]?.trim() === "") next++;
      value = lines[next]?.trim();
      if (
        !value ||
        TITLE_LABEL.test(value.replace(/:$/, "")) ||
        COMPANY_LABEL.test(value.replace(/:$/, "")) ||
        OTHER_LABEL.test(value) ||
        value.endsWith(":")
      )
        continue;
    }
    let rule: FieldRule = "ats:receipt-label";
    const linked = /^(.{2,140}?)\s+\((https:\/\/[^\s]+)\)$/.exec(value);
    if (linked) {
      // A label's link must name this exact public job. Never follow or persist the link here.
      if (!input.isPublicJobUrl(linked[2]!)) continue;
      value = linked[1]!;
      rule = "ats:receipt-linked-label";
    } else if (inline && CLASSIC_LABEL.test(label)) {
      // The generic labelled-field rule already reads this exact assertion.
      continue;
    }
    if (EMPTY_VALUE.test(value) || NAVIGATION.test(value)) continue;
    if (
      title &&
      /^(?:[A-Z]{0,6}[-_]?)?\d{3,20}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
    )
      continue;
    if (result.titles.length + result.companies.length >= 32) {
      result.limited = true;
      break;
    }
    (title ? result.titles : result.companies).push({
      value,
      weight: 4,
      rule,
      labelled: true,
    });
  }
  return result;
}
