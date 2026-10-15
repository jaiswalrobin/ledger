/**
 * Company and job-title extraction by weighted candidates.
 *
 * Every source (labelled lines, sentence patterns, subject templates, job-board blocks, calendar
 * events, signatures, the sender) proposes values with a weight. Values that several sources agree
 * on, or that match the sender's own domain, win. Strict validators reject anything that does not
 * look like a job title or an organisation, because a wrong value is worse than none: it creates a
 * separate job opening.
 */
import { parse as parseDomain } from "tldts";
import type { FieldDecision } from "./source.ts";
import { safeField } from "./privacy.ts";
import { isRecruitingSenderDomain, senderDomain } from "./ats.ts";
import { companyKey } from "../domain/normalization.ts";

/**
 * Every rule that proposes a company or title. The ids are stable and safe to persist: field
 * decisions record which rules proposed each candidate, and the parser evaluation reports which
 * rules produce wrong values and which never fire.
 */
export const FIELD_RULES = [
  "hint:calendar",
  "hint:workday-slug",
  "hint:ibm",
  "label:field",
  "label:requisition",
  "role:hired-as-at",
  "role:title-role-at",
  "role:title-role",
  "role:the-role-title-at",
  "role:the-role-title",
  "role:role-of-title",
  "role:your-application-for",
  "role:interview-for-at",
  "company:applied-to",
  "company:employment-with",
  "company:submitted-to",
  "company:viewed-by",
  "company:on-behalf-of",
  "company:from",
  "company:invited-you",
  "company:interview-with",
  "company:recruiter-at",
  "company:join",
  "signature:team",
  "signature:role",
  "sender:ats-display",
  "sender:department",
  "subject:prefix-at",
  "subject:prefix-pair",
  "subject:prefix-title",
  "subject:prefix-employer",
  "subject:leading-company",
  "subject:title-at",
  "subject:application-to",
  "subject:update-on",
  "subject:trailing-name",
  "subject:invite-name",
  "subject:domain-phrase",
  "calendar:event-line",
  "board:title-place",
  "board:company-title",
  "domain:confirms",
] as const;
export type FieldRule = (typeof FIELD_RULES)[number];

export interface FieldInput {
  subject: string;
  fromName: string;
  fromAddress: string | null;
  /** Normalized body with its line structure. */
  body: string;
  /** Signature text may name the employer, but cannot assert a new event or title. */
  signature?: string;
  /** Extra title suggestions from structured sources (Workday URL slug, employer templates). */
  titleHints?: readonly { value: string; weight: number; rule: FieldRule }[];
  companyHints?: readonly { value: string; weight: number; rule: FieldRule }[];
  /** Explicit aliases corroborate named candidates only; they never invent an employer. */
  companyAliases?: readonly { company: string; domain: string }[];
}

type Span = { representation: string; start: number; end: number };
type Candidate = {
  /** Written forms that share this candidate's key, each with its strongest support. */
  forms: Map<string, number>;
  order: number;
  fromContent: boolean;
  evidence: Map<string, number>;
  /** The rules that proposed this candidate, for attribution only (never for scoring). */
  rules: Set<FieldRule>;
  spans: Span[];
  spanOverflow?: boolean;
};
/** Candidates for one field, keyed so that variants of one value ("Acme", "Acme, Inc.") merge. */
type Candidates = Map<string, Candidate> & {
  keyOf: (value: string) => string;
  overflow?: boolean;
};

const titleKey = (value: string) =>
  value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const newCandidates = (keyOf: (value: string) => string): Candidates =>
  Object.assign(new Map<string, Candidate>(), { keyOf });
const hasCandidate = (map: Candidates, value: string) =>
  map.has(map.keyOf(value));

/**
 * The form shown for a merged candidate: a spelling that is not all capitals when there is one
 * ("Acme" over "ACME", but a lone "IBM" stays), then the best-supported, then the first seen.
 */
function displayForm(c: Candidate): string {
  const shouting = (v: string) =>
    /\p{Lu}{2,}/u.test(v) && v === v.toUpperCase();
  return [...c.forms.entries()].sort(
    ([a, wa], [b, wb]) => Number(shouting(a)) - Number(shouting(b)) || wb - wa,
  )[0]![0];
}

// ---- validation and cleaning ------------------------------------------------------------

/** Words that never appear inside a job title or company name, only in the prose around them. */
const PROSE =
  /\b(?:we|we've|we're|you|you've|your|our|us|i'd|have|has|had|decided|received|receive|been|will|would|could|please|thank|thanks|regret|unfortunately|reviewing|review|applying|applied|submitted|invited|invite|interest|candidacy|employment|following|after|before|because|which|that|this|these|those)\b/i;

/**
 * A capture that is really a status phrase or a sentence fragment, not a title. Whole phrases
 * only: "Account Executive" and "Community Manager" are titles, "account update" and "talent
 * community" are not.
 */
const TITLE_NOISE =
  /\b(?:update|invitation|status|confirmation|next steps?|reminder|regarding|alert|newsletter|(?:your|an?|new) account|account (?:update|created|activity|verification|settings|details)|talent (?:community|network|pool))\b|^(?:job|interview|assessment|offer|test)s?$/i;
/** A labelled value ("Job Title: ...") is only rejected when it is nothing but a status word. */
const LABEL_NOISE =
  /^(?:update|status|confirmation|reminder|n\/?a|none|tbd|job|interview|assessment|offer|test)s?$/i;

/**
 * How a value starts. Prose captures must start like a name: an upper-case letter, a digit, a
 * camel-cased brand ("iOS", "eBay") or a letter from a script without case. A labelled field
 * ("Job Title: software engineer") is the sender's own data entry, so any letter will do.
 */
const NAME_START = /^(?:[\p{Lu}\p{Lt}\p{Lo}\p{N}]|\p{Ll}\p{Lu})/u;
const LABEL_START = /^[\p{L}\p{N}]/u;

/** A date or clock time is never part of a job title: "Tuesday at 11 AM for the QA Engineer". */
const SCHEDULE_WORDS =
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|tonight)\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)(?![\p{L}])|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/iu;

/** An employer phrase that refers back to the sender's own organisation. */
const SELF_REFERENCE =
  /^(?:our|my)\b|^(?:the|this)\s+(?:[\p{L}-]+\s+){0,3}(?:company|team|organi[sz]ation|firm|business|office|offices|group|department|location|site|branch|studio|lab|store|headquarters|hq)$/iu;

const CALENDAR_WORD =
  /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|today|tomorrow|(?:this|next|last) (?:week|month|year))$/i;

/** Where a value was read. `label` is an explicit "Field: value" line; `prose` is anything else. */
export type FieldSource = "label" | "prose";

/** Hiring platforms, tools and job boards: senders and venues, never the employer. */
const PLATFORMS =
  /^(?:greenhouse|lever|workday|ashby|smartrecruiters|icims|jobvite|workable|taleo|successfactors|bamboohr|jazzhr|recruitee|teamtailor|breezy|pinpoint|comeet|hireology|eightfold|avature|brassring|phenom|jobadder|hackerrank|codility|codesignal|karat|hirevue|testgorilla|coderbyte|modern ?hire|wellfound|linkedin|indeed|glassdoor|ziprecruiter|google|google calendar|outlook|microsoft teams|zoom|calendly|goodtime)$/i;

/** Department words that trail a company in signatures and sender names. */
const DEPARTMENT =
  /\s+(?:careers?|recruit(?:ing|ment)(?:\s+team)?|talent(?:\s+(?:acquisition|team))?|people(?:\s+team)?|hr|human resources|hiring(?:\s+team)?|jobs|team|notifications?|no-?reply)$/i;

const GENERIC_COMPANY =
  /^(?:the\s+)?(?:talent|talent team|talent acquisition|people|people team|recruiting|recruitment|recruiting team|hiring team|hr|human resources|careers|team|jobs|candidate id|candidate|notifications?|no-?reply|support|admin|info|hello|hi|dear)$/i;

const REQUISITION =
  /\s*(?:[([]\s*(?:(?:req(?:uisition)?|job)\.?\s*(?:id|no\.?|#)?\s*[:#]?\s*)?[A-Z]{0,4}[-\s]?\d[\w-]*\s*[)\]]|\s[-–#]\s*[A-Z]{0,4}-?\d{3,}[\w-]*)\s*$/i;

export function cleanTitle(
  raw: string | null | undefined,
  source: FieldSource = "prose",
): string | null {
  let value = safeField(raw, 140);
  if (!value) return null;
  value = value
    // Quotes only: a trailing ")" may close a requisition number that REQUISITION removes.
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .replace(/^(?:the|our|a|an|your)\s+/i, "")
    .replace(
      /^(?:(?:position|role|job|post|vacancy)\s+(?:of|as)\s+|(?:position|role)\s+)/i,
      "",
    )
    .replace(REQUISITION, "")
    .replace(/\s+(?:position|role|job|opening|vacancy|opportunity)$/i, "")
    .replace(/[\s,.;:!-]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (
    value.length < 2 ||
    value.length > 100 ||
    value.split(" ").length > 12 ||
    !(source === "label" ? LABEL_START : NAME_START).test(value) ||
    /https?:|@|\d{4,}$/.test(value) ||
    PROSE.test(value) ||
    (source !== "label" && SCHEDULE_WORDS.test(value)) ||
    (source !== "label" &&
      /\b(?:position|role|job)\s+(?:at|with|is|has|was|will|been)\b|\bwith candidate\b/i.test(
        value,
      )) ||
    // "North America for the Backend Engineer": an earlier preposition swallowed the one that
    // introduces the role. Rejecting it lets the scan retry from the later preposition.
    (source !== "label" &&
      /\b(?:for|to|in|at|with|about|from)\s+(?:the|our|a|an|this|your)\b/i.test(
        value,
      )) ||
    (source === "label" ? LABEL_NOISE : TITLE_NOISE).test(value)
  )
    return null;
  return value;
}

/** A capture that is a role phrase ("Software Engineer role at Acme"), not an organisation. */
const ROLE_SHAPED =
  /\b(?:position|role|job|opening|vacancy|opportunity)(?:\s+(?:at|with|in)\b|$)/i;

/**
 * `strict` also rejects hiring platforms and tools. Use it where the value comes from a sender,
 * a venue or a loose phrase ("join Zoom", "assessment from HackerRank"); a sentence that names the
 * employer ("the Engineer position at Google") may name a company that also runs a platform.
 */
export function cleanCompany(
  raw: string | null | undefined,
  strict = true,
  source: FieldSource = "prose",
  /** The whole phrase is the sender's own organisation: keep connectors ("Code for America"). */
  senderNamed = false,
): string | null {
  let value = safeField(raw, 120);
  if (!value) return null;
  value = value
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .replace(/^the\s+/i, "")
    .replace(
      /\s*[:|]\s*(?:next steps?|application update|interview invitation|assessment invitation)\b.*$/i,
      "",
    );
  // A trailing clause ends the name; "and" only before a lower-case word, since "Barnes and
  // Noble" and "Johnson & Johnson" are names.
  if (!senderNamed)
    value = value
      .replace(
        /\s+(?:within|by|before|on|for|to|please|as|is|has|we|you|your|via|from)\b.*$/i,
        "",
      )
      .replace(/\s+and\s+\p{Ll}.*$/u, "");
  value = value
    .replace(/[\s"'”’)!.,;:]+$/g, "")
    .replace(DEPARTMENT, "")
    .replace(/\s+/g, " ")
    .trim();
  if (
    value.length < 2 ||
    value.length > 60 ||
    // Long names are real ("University of Texas MD Anderson Cancer Center"); longer is a sentence.
    value.split(" ").length > 10 ||
    !(source === "label" ? LABEL_START : NAME_START).test(value) ||
    /https?:|@|\d{5,}/.test(value) ||
    PROSE.test(value.replace(/^US(?=\s+\p{Lu})/u, "")) ||
    ROLE_SHAPED.test(value) ||
    // "your application in October": a date is never the employer.
    CALENDAR_WORD.test(value) ||
    (strict && PLATFORMS.test(value)) ||
    GENERIC_COMPANY.test(value)
  )
    return null;
  return value;
}

const compact = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

/** Corroborates an existing employer, never derives one from a domain. Private tenant suffixes
 * remain boundaries and recruiting/freemail domains do not assert an employer's identity. */
export function employerDomain(domain: string, company: string): string | null {
  if (isRecruitingSenderDomain(domain)) return null;
  const parsed = parseDomain(domain, {
    allowPrivateDomains: true,
    validateHostname: true,
  });
  const label = parsed.domainWithoutSuffix;
  if (!label || parsed.isIp || FREEMAIL.test(label) || PLATFORMS.test(label))
    return null;
  return compact(companyKey(company)) === compact(label) ? parsed.domain : null;
}

// ---- the sender's organisation, as evidence -----------------------------------------------

const FREEMAIL =
  /^(?:gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|aol|proton|protonmail|gmx|mail|zoho|yandex|fastmail)$/i;

/** Organisation labels of the sender and any calendar organiser, e.g. "umbrella", "massivedynamic". */
function domainHints(input: FieldInput): string[] {
  const labels: string[] = [];
  const add = (domain: string) => {
    if (!domain || isRecruitingSenderDomain(domain)) return;
    const parsed = parseDomain(domain, {
      allowPrivateDomains: true,
      validateHostname: true,
    });
    const label = parsed.isIp ? null : parsed.domainWithoutSuffix;
    if (
      label &&
      !FREEMAIL.test(label) &&
      !PLATFORMS.test(label) &&
      label.length >= 2
    )
      labels.push(label.toLowerCase());
  };
  add(input.fromAddress?.split("@")[1] ?? "");
  for (const m of input.body.matchAll(
    /^\s*(?:organi[sz]er|from|host)\s*:\s*[^\n@]*@([A-Za-z0-9.-]+)/gim,
  ))
    add(m[1]!.toLowerCase());
  return [...new Set(labels)];
}

// ---- patterns ---------------------------------------------------------------------------

const ROLE = String.raw`(?:position|role|job|opening|vacancy|opportunity)`;
const TITLE = String.raw`([\p{L}\p{N}][^\n.!?;:]{1,100}?)`;
const COMPANY = String.raw`([\p{L}\p{N}][^\n!?;:,.]{0,60}?)`;
// A company ends at punctuation or a connecting word. Patterns compile with the i flag, so case
// cannot tell "in Berlin" from "in Tech": "in" ends a name like "for" and "to" do, and a name
// that continues past a connector is recovered only when the sender's domain spells it.
const END = String.raw`(?=\s*(?:[.,!?;:]|\n|$|\s+(?:and|is|has|will|would|was|were|can|shall|we|team|as|on|for|to|please|where|who|in)\b))`;

const rx = (source: string, flags = "iu") => new RegExp(source, flags);

/** Sentences naming a role, optionally followed by the employer. Highest-precision patterns first. */
const ROLE_SENTENCES: {
  rule: FieldRule;
  re: RegExp;
  title: number;
  company?: number;
  weight: number;
}[] = [
  // "offer you employment as a Risk Analyst at Gringotts", "hire you as Staff Engineer with Acme",
  // "join us as a Data Scientist at Initech".
  {
    rule: "role:hired-as-at",
    re: rx(
      String.raw`\b(?:employment|offer(?:ing)?\s+you(?:\s+(?:a|the)\s+(?:position|role|job))?|hire\s+you|join(?:ing)?\s+(?:us|the\s+team))\s+as\s+(?:an?\s+)?${TITLE}\s+(?:at|with)\s+${COMPANY}${END}`,
    ),
    title: 1,
    company: 2,
    weight: 3,
  },
  // "for the Senior Data Analyst position at Visa", "to our Software Engineer, Payments role"
  {
    rule: "role:title-role-at",
    re: rx(
      String.raw`\b(?:for|to|in|about|offer\s+you|offering\s+you)\s+(?:(?:the|our|a|an|this)\s+)?${TITLE}\s+${ROLE}\s+(?:at|with)\s+${COMPANY}${END}`,
    ),
    title: 1,
    company: 2,
    weight: 3,
  },
  {
    rule: "role:title-role",
    re: rx(
      String.raw`\b(?:for|to|in|about|offer\s+you|offering\s+you)\s+(?:(?:the|our|a|an|this)\s+)?${TITLE}\s+${ROLE}\b`,
    ),
    title: 1,
    weight: 2.5,
  },
  // "the position Backend Engineer at Klarna", "the position Data Engineer."
  {
    rule: "role:the-role-title-at",
    re: rx(
      String.raw`\bthe\s+${ROLE}\s+(?:of\s+)?${TITLE}\s+(?:at|with)\s+${COMPANY}${END}`,
    ),
    title: 1,
    company: 2,
    weight: 3,
  },
  {
    rule: "role:the-role-title",
    re: rx(String.raw`\bthe\s+${ROLE}\s+(?:of\s+)?${TITLE}${END}`),
    title: 1,
    weight: 2,
  },
  // "an offer for the role of Senior Software Engineer at Acme", "the role of Data Scientist - 45678"
  {
    rule: "role:role-of-title",
    re: rx(
      String.raw`\b${ROLE}\s+(?:of|as)\s+(?:an?\s+)?${TITLE}(?:\s+with\s+candidate\b|\s+(?:at|with)\s+(?!candidate\b)${COMPANY}${END}|${END})`,
    ),
    title: 1,
    company: 2,
    weight: 2.5,
  },
  // "Spotify viewed your application for Backend Engineer."
  {
    rule: "role:your-application-for",
    re: rx(
      String.raw`\byour\s+application\s+for\s+(?:the\s+)?${TITLE}(?:\s+(?:at|with)\s+${COMPANY})?${END}`,
    ),
    title: 1,
    company: 2,
    weight: 1.5,
  },
  // "applying for the Frontend Developer job at Contoso Labs" (covered above) and "interview for X at Y"
  {
    rule: "role:interview-for-at",
    re: rx(
      String.raw`\b(?:interview|assessment|test|screen|challenge)\s+for\s+(?:the\s+)?${TITLE}\s+(?:${ROLE}\s+)?at\s+${COMPANY}${END}`,
    ),
    title: 1,
    company: 2,
    weight: 2.5,
  },
];

/** Phrases that name only the employer. */
const COMPANY_SENTENCES: {
  rule: FieldRule;
  re: RegExp;
  weight: number;
  strict?: boolean;
  affiliation?: boolean;
}[] = [
  {
    rule: "company:applied-to",
    re: rx(
      String.raw`\b(?:applying|applied|application|apply|interest|candidacy|career|future)\s+(?:to|at|with|in)\s+${COMPANY}${END}`,
    ),
    weight: 1.5,
  },
  {
    rule: "company:employment-with",
    re: rx(String.raw`\bemployment\s+(?:with|at)\s+${COMPANY}${END}`),
    weight: 2,
  },
  {
    rule: "company:submitted-to",
    re: rx(String.raw`\b(?:sent|submitted)\s+to\s+${COMPANY}${END}`),
    weight: 2,
  },
  {
    rule: "company:viewed-by",
    re: rx(String.raw`\b(?:viewed|reviewed)\s+by\s+${COMPANY}${END}`),
    weight: 2,
  },
  {
    rule: "company:on-behalf-of",
    re: rx(String.raw`\bon\s+behalf\s+of\s+${COMPANY}${END}`),
    weight: 2,
  },
  // "assessment from HackerRank" names the tool as often as the employer.
  {
    rule: "company:from",
    re: rx(
      String.raw`\b(?:test|assessment|challenge|invitation|offer)\s+from\s+${COMPANY}${END}`,
    ),
    weight: 2,
    strict: true,
  },
  {
    rule: "company:invited-you",
    re: rx(
      String.raw`(?:^|\n|\.\s+)${COMPANY}\s+(?:has|have)\s+invited\s+you\b`,
    ),
    weight: 2.5,
  },
  {
    rule: "company:interview-with",
    re: rx(String.raw`\binterview(?:ing)?\s+with\s+${COMPANY}${END}`),
    weight: 1.5,
  },
  // "I'm a recruiter at Aperture", "the hiring team at Hooli"
  {
    rule: "company:recruiter-at",
    re: rx(
      String.raw`\b(?:recruiter|recruiting|talent\s+partner|hiring\s+manager|hiring\s+team|team|coordinator)\s+(?:at|with)\s+${COMPANY}${END}`,
    ),
    weight: 1.5,
    affiliation: true,
  },
  {
    rule: "company:join",
    re: rx(
      String.raw`\b(?:join|joining|welcome\s+to)\s+(?:the\s+)?${COMPANY}${END}`,
    ),
    weight: 1,
    strict: true,
  },
];

/** Subject lines: an event phrase followed by "Title", "Title at Company" or "Title - Company". */
const SUBJECT_PREFIX = String.raw`(?:application\s+(?:received|confirmation|submitted)|interview\s+(?:confirmed|confirmation|invitation|scheduled|request)|invitation\s+to\s+interview|offer\s+of\s+employment|offer\s+letter|offer|indeed\s+application|your\s+application\s+(?:for|to)|application\s+for|thank\s+you\s+for\s+(?:applying|your\s+application)|thanks\s+for\s+applying|regarding\s+your\s+application\s+(?:for|to)|update\s+on\s+(?:your\s+application\s+(?:for|to)|the))`;

// ---- collection -------------------------------------------------------------------------

/**
 * Runs `re` over `text`. When `accept` rejects a match, scanning resumes one character later
 * instead of after it: in "to the next round for the SRE role", the invalid capture starting at
 * "to" must not hide the valid one starting at "for".
 */
function scan(
  re: RegExp,
  text: string,
  accept: (m: RegExpExecArray) => boolean,
) {
  const g = new RegExp(
    re.source,
    re.flags.includes("g") ? re.flags : re.flags + "g",
  );
  for (let m = g.exec(text); m; m = g.exec(text)) {
    if (!accept(m)) g.lastIndex = m.index + 1;
    else if (m[0].length === 0) g.lastIndex += 1;
  }
}

/**
 * Where a candidate was read. Support is the sum over distinct sources of each source's strongest
 * mention, so:
 * - the subject is one statement: every rule that reads it shares one source;
 * - in the body, different mechanisms (a labelled line, a sentence, a calendar line, a job-board
 *   block, a signature) corroborate each other;
 * - repeats of one mechanism, and the wrapped and flattened copies of one sentence, count once.
 * Repetition therefore cannot outweigh an explicit field, and agreement still adds up.
 */
type Source =
  | "structured:hint"
  | "subject"
  | "body:label"
  | "body:sentence"
  | "body:calendar"
  | "body:layout"
  | "body:signature"
  | "sender:display"
  | "domain";

/** `fromContent` is false for the sender's display name and signatures, which only corroborate. */
function add(
  map: Candidates,
  value: string | null,
  weight: number,
  source: Source,
  rule: FieldRule,
  { fromContent = true, span }: { fromContent?: boolean; span?: Span } = {},
) {
  if (!value || weight <= 0) return;
  const key = map.keyOf(value);
  let candidate = map.get(key);
  if (!candidate) {
    if (map.size >= 64) {
      map.overflow = true;
      return;
    }
    candidate = {
      forms: new Map(),
      order: map.size,
      fromContent,
      evidence: new Map(),
      rules: new Set(),
      spans: [],
    };
    map.set(key, candidate);
  }
  candidate.forms.set(value, Math.max(weight, candidate.forms.get(value) ?? 0));
  candidate.evidence.set(
    source,
    Math.max(weight, candidate.evidence.get(source) ?? 0),
  );
  candidate.rules.add(rule);
  candidate.fromContent ||= fromContent;
  if (span && candidate.spans.length < 128) candidate.spans.push(span);
  else if (span) candidate.spanOverflow = true;
}

function decide(map: Candidates): FieldDecision {
  const candidates = [...map.values()]
    .map((c) => ({
      value: displayForm(c),
      score: [...c.evidence.values()].reduce((sum, weight) => sum + weight, 0),
      sources: [...c.evidence.keys()].sort(),
      rules: [...c.rules].sort(),
      credible:
        c.fromContent &&
        [...c.evidence.entries()].some(
          ([source, weight]) => source !== "domain" && weight >= 1.5,
        ),
      order: c.order,
    }))
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const best = candidates[0];
  const ambiguous =
    map.overflow === true ||
    candidates.filter((c) => c.credible).length > 1 ||
    (candidates.length > 1 && best!.score === candidates[1]!.score);
  return {
    state: ambiguous
      ? "AMBIGUOUS"
      : best && best.score >= 1
        ? "SUPPORTED"
        : "MISSING",
    value: !ambiguous && best && best.score >= 1 ? best.value : null,
    // Bounded by FIELD_RULES, so attribution survives the cut to eight candidates below.
    firedRules: [...new Set(candidates.flatMap((c) => c.rules))].sort(),
    // Bounded, safe facts only. Never persist matching sentences, addresses, or snippets.
    candidates: candidates
      .slice(0, 8)
      .map(({ value, score, sources, rules }) => ({
        value,
        score,
        sources,
        rules,
      })),
  };
}

/** Splits "A - B" / "A | B" when one side is the employer according to other evidence. */
function splitPair(text: string, isCompany: (v: string) => boolean) {
  const parts = text
    .split(/\s+[-–|·]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length !== 2) return null;
  const [a, b] = parts as [string, string];
  if (isCompany(a) && !isCompany(b)) return { company: a, title: b };
  if (isCompany(b) && !isCompany(a)) return { company: b, title: a };
  return null;
}

export function extractCompanyAndTitle(input: FieldInput): {
  company: string | null;
  title: string | null;
  decisions: { company: FieldDecision; title: FieldDecision };
} {
  const titles = newCandidates(titleKey);
  const companies = newCandidates(companyKey);
  const frames = new Map<string, { title: string; company: string | null }>();
  const { subject, body } = input;
  const flat = body.replace(/\s+/g, " ");
  const lines = body.split("\n").map((l) => l.trim());
  const hints = domainHints(input);
  const matchesDomain = (value: string) =>
    hints.some((h) => compact(companyKey(value)) === compact(h)) ||
    (input.companyAliases ?? []).some(
      (alias) =>
        companyKey(alias.company) === companyKey(value) &&
        hints.includes(
          parseDomain(alias.domain, { allowPrivateDomains: true })
            .domainWithoutSuffix ?? "",
        ),
    );

  for (const h of input.titleHints ?? [])
    add(titles, cleanTitle(h.value), h.weight, "structured:hint", h.rule);
  for (const h of input.companyHints ?? [])
    add(companies, cleanCompany(h.value), h.weight, "structured:hint", h.rule);

  // Labelled fields: "Job Title: ...", "Company: ...".
  for (const line of lines) {
    const label =
      /^(job\s*title|position(?:\s*title)?|role|title|job|company|employer|organi[sz]ation)\s*[:\-–]\s*(.{2,100})$/i.exec(
        line,
      );
    if (!label) continue;
    if (/company|employer|organi/i.test(label[1]!))
      add(
        companies,
        cleanCompany(label[2], false, "label"),
        4,
        "body:label",
        "label:field",
      );
    else
      add(
        titles,
        cleanTitle(label[2], "label"),
        4,
        "body:label",
        "label:field",
      );
  }

  // A company capture stops at a connector (END). The name continues when:
  // - "and"/"&" joins capitalised words up to the end of the clause ("Barnes and Noble");
  // - the longer phrase is the sender's own organisation ("Code for America" from
  //   codeforamerica.org, "Women in Tech" from womenintech.org), but not "Zalando in Berlin".
  const companyFrom = (m: RegExpExecArray, group: number, strict: boolean) => {
    const value = fullCompany(m, group);
    return value && value !== m[group] && matchesDomain(value)
      ? cleanCompany(value, strict, "prose", true)
      : cleanCompany(value, strict);
  };
  const fullCompany = (m: RegExpExecArray, group: number) => {
    const value = m[group];
    if (!value || !m[0].endsWith(value)) return value;
    const end = m.index + m[0].length;
    const start = end - value.length;
    const following = m.input.slice(end);
    const joined =
      /^\s+(?:and|&)\s+(\p{Lu}[\p{L}\p{N}'&.-]*(?:\s+\p{Lu}[\p{L}\p{N}'&.-]*){0,3})(?=\s*(?:[.,!?;:\n]|$))/u.exec(
        following,
      );
    if (joined) return m.input.slice(start, end + joined[0].length);
    const clause = /^[^\n.,!?;:]{0,80}/.exec(following)![0];
    const words = clause.split(/\s+/).filter(Boolean).slice(0, 6);
    for (let n = words.length; n >= 1; n--) {
      const longer = `${value} ${words.slice(0, n).join(" ")}`;
      if (matchesDomain(longer)) return longer;
    }
    return value;
  };

  // Employer-agnostic requisition labels identify a title, never an application attempt ID.
  for (const line of lines) {
    const reference =
      /^(?:ref(?:erence)?|requisition(?: id)?)\s*:\s*[A-Z]{0,4}[- ]?\d{3,12}\s*[-–]\s*(.{2,100})$/i.exec(
        line,
      );
    if (reference)
      add(
        titles,
        cleanTitle(reference[1], "label"),
        3,
        "body:label",
        "label:requisition",
      );
  }
  // Role sentences, over the hard-wrapped lines and the flattened text.
  const sentenceSources = [
    { source: "subject", representation: "subject", text: subject },
    { source: "body:sentence", representation: "body-lines", text: body },
    { source: "body:sentence", representation: "body-flat", text: flat },
  ] as const;
  for (const { source, representation, text } of sentenceSources)
    for (const p of ROLE_SENTENCES)
      scan(p.re, text, (m) => {
        const title = cleanTitle(m[p.title]);
        if (!title) return false;
        const start = m.index + m[0].indexOf(m[p.title]!);
        add(titles, title, p.weight, source, p.rule, {
          span: { representation, start, end: start + m[p.title]!.length },
        });
        if (p.company && m[p.company]) {
          const company = companyFrom(m, p.company, false);
          add(companies, company, p.weight, source, p.rule);
          // "at our company", "at our Berlin office", "with the team": the sender refers to itself,
          // which binds the role to no other employer. ("at 123456" still binds it to an unknown one.)
          if (!company && SELF_REFERENCE.test(m[p.company]!)) return true;
          const frame = {
            title: titleKey(title),
            company: company ? companyKey(company) : null,
          };
          const id = JSON.stringify(frame);
          if (frames.has(id) || frames.size < 128) frames.set(id, frame);
          else titles.overflow = true;
        }
        return true;
      });
  for (const { source, text } of sentenceSources.slice(0, 2))
    for (const p of COMPANY_SENTENCES)
      scan(p.re, text, (m) => {
        const company = companyFrom(m, 1, p.strict ?? false);
        add(
          companies,
          company,
          p.weight,
          p.affiliation ? "body:signature" : source,
          p.rule,
          {
            fromContent: !p.affiliation,
          },
        );
        return !!company;
      });

  // Signatures: "Stripe Recruiting", "The Datadog Recruiting Team", "Technical Recruiter, Acme".
  for (const line of [
    ...lines.slice(-8),
    ...(input.signature ?? "").split("\n").map((line) => line.trim()),
  ]) {
    const team =
      /^(?:the\s+)?(.{2,50}?)\s+(?:recruit(?:ing|ment)|talent(?:\s+acquisition)?|careers|hr|people)(?:\s+team)?$/i.exec(
        line,
      );
    if (team)
      add(
        companies,
        cleanCompany(team[1]),
        1.5,
        "body:signature",
        "signature:team",
        { fromContent: false },
      );
    const role =
      /^(?:senior\s+|lead\s+)?(?:technical\s+)?(?:recruiter|talent\s+partner|talent\s+acquisition[\w ]*|hiring\s+manager|hr\s+[\w ]+),\s*(.{2,50})$/i.exec(
        line,
      );
    if (role)
      add(
        companies,
        cleanCompany(role[1]),
        2,
        "body:signature",
        "signature:role",
        { fromContent: false },
      );
  }

  // The sender: an ATS display name is the employer; elsewhere only when it is a department
  // ("Barclays Recruitment") or the organisation the address belongs to.
  const display = input.fromName
    .replace(/\s+(?:via|from|on behalf of)\s+.*$/i, "")
    .trim();
  const domain = senderDomain(input.fromAddress ?? "");
  if (display) {
    const cleaned = cleanCompany(display);
    if (cleaned) {
      if (isRecruitingSenderDomain(domain))
        add(companies, cleaned, 1.5, "sender:display", "sender:ats-display", {
          fromContent: false,
        });
      // "Barclays Recruitment", "Contoso Careers": a hiring department names its organisation. A
      // plain organisation name ("Career Weekly") may be a newsletter, not an employer.
      else if (DEPARTMENT.test(` ${display}`))
        add(companies, cleaned, 1.5, "sender:display", "sender:department", {
          fromContent: false,
        });
    }
  }

  // Subject templates.
  const prefixed = rx(
    String.raw`^(?:[^:]{0,40}:\s*)?(${SUBJECT_PREFIX})\s*([:\-–|]|\bfor\b|\bto\b)?\s*(?:the\s+)?(.+)$`,
  ).exec(subject);
  let prefixedUsed = false;
  const before = titles.size + companies.size;
  if (prefixed) {
    // Only a requisition number is metadata; "(Frontend)" or "(Remote)" is part of the title.
    const rest = prefixed[3]!.replace(REQUISITION, "").trim();
    // "... to Stripe" names the employer; "... for Data Engineer" or "...: Data Engineer" the role.
    const toEmployer =
      /\bto$/i.test(prefixed[1]!) || /^to$/i.test(prefixed[2] ?? "");
    const at = /^(.+?)\s+(?:job\s+)?(?:at|@|with)\s+(.+)$/i.exec(rest);
    if (at) {
      add(titles, cleanTitle(at[1]), 2.5, "subject", "subject:prefix-at");
      add(companies, cleanCompany(at[2]), 2.5, "subject", "subject:prefix-at");
    } else {
      const pair = splitPair(rest, (v) => {
        const cleaned = cleanCompany(v, false);
        return (
          !!cleaned &&
          (matchesDomain(cleaned) || hasCandidate(companies, cleaned))
        );
      });
      if (pair) {
        add(
          titles,
          cleanTitle(pair.title),
          2.5,
          "subject",
          "subject:prefix-pair",
        );
        add(
          companies,
          cleanCompany(pair.company),
          2.5,
          "subject",
          "subject:prefix-pair",
        );
      } else if (!/\s[-–|]\s/.test(rest)) {
        // A lone remainder is a title ("Application received: ML Engineer") or the employer
        // ("Your application to Stripe"); the employer reading needs corroboration.
        if (toEmployer)
          add(
            companies,
            cleanCompany(rest),
            2,
            "subject",
            "subject:prefix-employer",
          );
        else
          add(titles, cleanTitle(rest), 2, "subject", "subject:prefix-title");
      }
    }
  }
  prefixedUsed = titles.size + companies.size > before;
  // "Company - Application Received - Title (Req 1)", "Company: Thank you for your application",
  // "Company - Video Interview Invitation".
  const leading =
    /^([^:\-–|]{2,60}?)\s*[:\-–|]\s*(?:application\s+received|thank\s+you\s+for\s+your\s+application|(?:video\s+)?interview\s+invitation|your\s+application|application\s+update)\b(?:\s*[-–|:]\s*(.+))?$/i.exec(
      subject,
    );
  if (leading) {
    add(
      companies,
      cleanCompany(leading[1]),
      2.5,
      "subject",
      "subject:leading-company",
    );
    if (leading[2])
      add(
        titles,
        cleanTitle(leading[2]),
        2.5,
        "subject",
        "subject:leading-company",
      );
  }
  const subjectAt =
    /^(?:[^:]{2,60}:\s*)?(.{2,100}?)\s+(?:at|@)\s+([A-Z0-9][^:]{1,60})$/.exec(
      subject,
    );
  const invite = /^(?:updated\s+)?invitation:\s*(.+?)\s+@\s/i.exec(subject);
  // In a calendar invite the "@" introduces the time, not the employer.
  if (subjectAt && !prefixedUsed && !invite) {
    add(titles, cleanTitle(subjectAt[1]), 2, "subject", "subject:title-at");
    add(
      companies,
      cleanCompany(subjectAt[2]),
      2,
      "subject",
      "subject:title-at",
    );
  }
  for (const m of subject.matchAll(
    /\b(?:offer|application|candidacy|interview)\s+(?:from|to|at|with)\s+([A-Z0-9][^:|,]{1,60})$/gi,
  ))
    add(companies, cleanCompany(m[1]), 2, "subject", "subject:application-to");
  // Case-sensitive for the capitalised name, so the subject's own first word is matched in either case.
  for (const m of subject.matchAll(
    /\b(?:[Uu]pdate|[Nn]ews)\s+on\s+your\s+([A-Z0-9][\w&' .-]{1,40}?)\s+application\b/g,
  ))
    add(companies, cleanCompany(m[1]), 2, "subject", "subject:update-on");
  // "Interview Confirmation and Details- Weave", "Next steps | Acme": a trailing name after a dash
  // or bar, spaced or not, counts only when it is the sender's own organisation.
  const trailing = /[-–|]\s*([\p{L}\p{N}][^-–|:!?]{1,60}?)\s*$/u.exec(subject);
  if (trailing && matchesDomain(trailing[1]!))
    add(
      companies,
      cleanCompany(trailing[1]),
      2.5,
      "subject",
      "subject:trailing-name",
    );

  // Calendar invites: "Invitation: Robin / Hooli - Technical Interview @ ..." and an event line
  // "Technical Interview - Senior Backend Engineer".
  if (invite) {
    for (const name of invite[1]!.split(/\s*(?:\/|<>|&|\+|\bx\b|[-–|])\s*/))
      if (matchesDomain(name))
        add(companies, cleanCompany(name), 3, "subject", "subject:invite-name");
  }
  for (const line of lines) {
    const event =
      /^(?:[\w ]{0,30}\binterview|phone screen|onsite|technical screen)\s*[-–:|]\s*(.{2,100})$/i.exec(
        line,
      );
    if (event)
      add(
        titles,
        cleanTitle(event[1]),
        2,
        "body:calendar",
        "calendar:event-line",
      );
  }

  // Job-board blocks: a company line followed by a title line (LinkedIn), or a title line followed
  // by "Company - Place" (Indeed).
  const boardDomain = senderDomain(input.fromAddress ?? "");
  const isBoard = /(?:^|\.)(?:linkedin\.com|indeed\.com)$/.test(boardDomain);
  const anchor = lines.findIndex((line) =>
    /\b(?:application (?:was |has been |successfully )?(?:sent|submitted|received)|you(?:'ve| have) applied)\b/i.test(
      line,
    ),
  );
  const boardLines =
    isBoard && anchor >= 0 ? lines.slice(anchor + 1, anchor + 16) : [];
  for (let i = 0; i + 1 < boardLines.length; i++) {
    const here = boardLines[i]!,
      next = boardLines[i + 1]!;
    const placeLine =
      /^(.{2,60}?)\s+[-–]\s+(?:[A-Z][\w .'-]+,\s*[A-Z]{2}\b|remote|hybrid|[A-Z][\w .'-]+,\s*[A-Z][a-z]+)/.exec(
        next,
      );
    if (placeLine && cleanTitle(here) && !PROSE.test(here)) {
      add(titles, cleanTitle(here), 1.5, "body:layout", "board:title-place");
      add(
        companies,
        cleanCompany(placeLine[1]),
        1.5,
        "body:layout",
        "board:title-place",
      );
    }
    const location = boardLines[i + 2] ?? "";
    const hasLocation =
      /^(?:remote|hybrid|on[- ]site|[\p{L} .'-]+,\s*[\p{L} .'-]+)/iu.test(
        location,
      );
    if (
      hasCandidate(companies, here) &&
      cleanTitle(next) &&
      here.length <= 60 &&
      hasLocation
    )
      add(titles, cleanTitle(next), 1.5, "body:layout", "board:company-title");
  }

  // The sender's own domain confirms a candidate the message itself names; it never invents one,
  // and it does not re-confirm the sender's display name (that would count one source twice).
  for (const c of companies.values())
    if (c.fromContent && [...c.forms.keys()].some(matchesDomain)) {
      c.evidence.set("domain", 2);
      c.rules.add("domain:confirms");
    }
  // Capitalised words in the subject that spell the sender's organisation ("Massive Dynamic").
  if (hints.length)
    for (const m of subject.matchAll(
      /\b([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,3})\b/g,
    ))
      for (let n = m[1]!.split(" ").length; n >= 1; n--) {
        const phrase = m[1]!.split(" ").slice(0, n).join(" ");
        if (
          hints.includes(compact(phrase)) &&
          ![...companies.values()].some((c) =>
            [...c.forms.keys()].some((form) =>
              compact(form).startsWith(compact(phrase)),
            ),
          )
        )
          add(
            companies,
            cleanCompany(phrase),
            1.5,
            "subject",
            "subject:domain-phrase",
          );
      }

  // A title must not be the employer's own name.
  for (const company of companies.values())
    for (const form of company.forms.keys()) {
      const name = titleKey(form);
      titles.delete(name);
      // A less specific rule may capture the employer suffix as part of the title.
      for (const [key, candidate] of titles)
        if (
          !candidate.evidence.has("structured:hint") &&
          (key.endsWith(` at ${name}`) || key.endsWith(` with ${name}`))
        )
          titles.delete(key);
    }

  // "applying to the Software Engineer, Editor role" also reads "Software Engineer" as an employer:
  // a company that is the part of a title before its comma is a clipped title.
  for (const [key, company] of companies)
    if (
      [...company.forms.keys()].some((form) =>
        [...titles.values()].some((t) =>
          [...t.forms.keys()].some((title) =>
            titleKey(title).startsWith(`${titleKey(form)},`),
          ),
        ),
      )
    )
      companies.delete(key);

  // A general sentence rule can stop at an internal comma. Discard only a proven subspan
  // of the more specific title in the same representation; distinct mentions still conflict.
  for (const [key, candidate] of titles)
    if (
      !candidate.spanOverflow &&
      candidate.spans.length &&
      [...titles.values()].some(
        (other) =>
          other !== candidate &&
          [...other.forms.keys()].some((form) =>
            titleKey(form).startsWith(`${key},`),
          ) &&
          candidate.spans.every((short) =>
            other.spans.some(
              (long) =>
                long.representation === short.representation &&
                long.start <= short.start &&
                long.end > short.end,
            ),
          ),
      )
    )
      titles.delete(key);
  const decisions = { company: decide(companies), title: decide(titles) };
  if (decisions.company.value && decisions.title.value) {
    const bound = [...frames.values()].filter(
      (frame) => frame.title === titleKey(decisions.title.value!),
    );
    // An explicitly bound role cannot be reassigned to an unrelated winning sender/company.
    // A rejected employer capture is also insufficient evidence for such a reassignment.
    const structuredPair =
      titles
        .get(titleKey(decisions.title.value))
        ?.evidence.has("structured:hint") &&
      companies
        .get(companyKey(decisions.company.value))
        ?.evidence.has("structured:hint");
    if (
      !structuredPair &&
      bound.length &&
      !bound.some(
        (frame) => frame.company === companyKey(decisions.company.value!),
      )
    )
      decisions.title = { ...decisions.title, state: "AMBIGUOUS", value: null };
  }
  return {
    company: decisions.company.value,
    title: decisions.title.value,
    decisions,
  };
}
