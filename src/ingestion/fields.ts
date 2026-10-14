/**
 * Company and job-title extraction by weighted candidates.
 *
 * Every source (labelled lines, sentence patterns, subject templates, job-board blocks, calendar
 * events, signatures, the sender) proposes values with a weight. Values that several sources agree
 * on, or that match the sender's own domain, win. Strict validators reject anything that does not
 * look like a job title or an organisation, because a wrong value is worse than none: it creates a
 * separate job opening.
 */
import { safeField } from "./privacy.ts";
import { isRecruitingSenderDomain, senderDomain } from "./ats.ts";

export interface FieldInput {
  subject: string;
  fromName: string;
  fromAddress: string | null;
  /** Normalized body with its line structure. */
  body: string;
  /** Extra title suggestions from structured sources (Workday URL slug, employer templates). */
  titleHints?: readonly { value: string; weight: number }[];
  companyHints?: readonly { value: string; weight: number }[];
}

type Candidate = { value: string; weight: number; order: number; fromContent: boolean };
type Candidates = Map<string, Candidate>;

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
const LABEL_NOISE = /^(?:update|status|confirmation|reminder|n\/?a|none|tbd|job|interview|assessment|offer|test)s?$/i;

/**
 * How a value starts. Prose captures must start like a name: an upper-case letter, a digit, a
 * camel-cased brand ("iOS", "eBay") or a letter from a script without case. A labelled field
 * ("Job Title: software engineer") is the sender's own data entry, so any letter will do.
 */
const NAME_START = /^(?:[\p{Lu}\p{Lt}\p{Lo}\p{N}]|\p{Ll}\p{Lu})/u;
const LABEL_START = /^[\p{L}\p{N}]/u;

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

export function cleanTitle(raw: string | null | undefined, source: FieldSource = "prose"): string | null {
  let value = safeField(raw, 140);
  if (!value) return null;
  value = value
    // Quotes only: a trailing ")" may close a requisition number that REQUISITION removes.
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .replace(/^(?:the|our|a|an|your)\s+/i, "")
    .replace(/^(?:(?:position|role|job|post|vacancy)\s+(?:of|as)\s+|(?:position|role)\s+)/i, "")
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
    (source === "label" ? LABEL_NOISE : TITLE_NOISE).test(value)
  )
    return null;
  return value;
}

/** A capture that is a role phrase ("Software Engineer role at Acme"), not an organisation. */
const ROLE_SHAPED = /\b(?:position|role|job|opening|vacancy|opportunity)(?:\s+(?:at|with|in)\b|$)/i;

/**
 * `strict` also rejects hiring platforms and tools. Use it where the value comes from a sender,
 * a venue or a loose phrase ("join Zoom", "assessment from HackerRank"); a sentence that names the
 * employer ("the Engineer position at Google") may name a company that also runs a platform.
 */
export function cleanCompany(
  raw: string | null | undefined,
  strict = true,
  source: FieldSource = "prose",
): string | null {
  let value = safeField(raw, 120);
  if (!value) return null;
  value = value
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .replace(/^the\s+/i, "")
    // A trailing clause ends the name; "and" only before a lower-case word, since "Barnes and
    // Noble" and "Johnson & Johnson" are names.
    .replace(/\s+(?:within|by|before|on|for|to|please|as|is|has|we|you|your|via|from)\b.*$/i, "")
    .replace(/\s+and\s+\p{Ll}.*$/u, "")
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
    PROSE.test(value) ||
    ROLE_SHAPED.test(value) ||
    (strict && PLATFORMS.test(value)) ||
    GENERIC_COMPANY.test(value)
  )
    return null;
  return value;
}

const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

// ---- the sender's organisation, as evidence -----------------------------------------------

const FREEMAIL =
  /^(?:gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|aol|proton|protonmail|gmx|mail|zoho|yandex|fastmail)$/i;

/** Organisation labels of the sender and any calendar organiser, e.g. "umbrella", "massivedynamic". */
function domainHints(input: FieldInput): string[] {
  const labels: string[] = [];
  const add = (domain: string) => {
    if (!domain || isRecruitingSenderDomain(domain)) return;
    const parts = domain.split(".").filter(Boolean);
    // The registrable label: "careers.acme.co.uk" -> "acme", "hooli.example" -> "hooli".
    const generic = /^(?:co|com|org|net|ac|gov|edu|example|io|ai|app|dev|careers|jobs|mail|email|hr|recruiting|talent)$/i;
    const label = [...parts].reverse().find((p, i) => i > 0 && !generic.test(p)) ?? parts[0];
    if (label && !FREEMAIL.test(label) && !PLATFORMS.test(label) && label.length >= 2)
      labels.push(label.toLowerCase());
  };
  add(input.fromAddress?.split("@")[1] ?? "");
  for (const m of input.body.matchAll(/^\s*(?:organi[sz]er|from|host)\s*:\s*[^\n@]*@([A-Za-z0-9.-]+)/gim))
    add(m[1]!.toLowerCase());
  return [...new Set(labels)];
}

// ---- patterns ---------------------------------------------------------------------------

const ROLE = String.raw`(?:position|role|job|opening|vacancy|opportunity)`;
const TITLE = String.raw`([\p{L}\p{N}][^\n.!?;:]{1,100}?)`;
const COMPANY = String.raw`([\p{L}\p{N}][^\n!?;:,.]{0,60}?)`;
const END = String.raw`(?=\s*(?:[.,!?;:]|\n|$|\s+(?:and|is|has|we|team|as|on|for|to|please|where|who|in\s+[A-Z])\b))`;

const rx = (source: string, flags = "iu") => new RegExp(source, flags);

/** Sentences naming a role, optionally followed by the employer. Highest-precision patterns first. */
const ROLE_SENTENCES: { re: RegExp; title: number; company?: number; weight: number }[] = [
  // "for the Senior Data Analyst position at Visa", "to our Software Engineer, Payments role"
  { re: rx(String.raw`\b(?:for|to|in|about|offer\s+you|offering\s+you)\s+(?:(?:the|our|a|an|this)\s+)?${TITLE}\s+${ROLE}\s+(?:at|with)\s+${COMPANY}${END}`), title: 1, company: 2, weight: 3 },
  { re: rx(String.raw`\b(?:for|to|in|about|offer\s+you|offering\s+you)\s+(?:(?:the|our|a|an|this)\s+)?${TITLE}\s+${ROLE}\b`), title: 1, weight: 2.5 },
  // "the position Backend Engineer at Klarna", "the position Data Engineer."
  { re: rx(String.raw`\bthe\s+${ROLE}\s+(?:of\s+)?${TITLE}\s+(?:at|with)\s+${COMPANY}${END}`), title: 1, company: 2, weight: 3 },
  { re: rx(String.raw`\bthe\s+${ROLE}\s+(?:of\s+)?${TITLE}${END}`), title: 1, weight: 2 },
  // "an offer for the role of Senior Software Engineer at Acme", "the role of Data Scientist - 45678"
  { re: rx(String.raw`\b${ROLE}\s+(?:of|as)\s+(?:an?\s+)?${TITLE}(?:\s+with\s+candidate\b|\s+(?:at|with)\s+(?!candidate\b)${COMPANY}${END}|${END})`), title: 1, company: 2, weight: 2.5 },
  // "Spotify viewed your application for Backend Engineer."
  { re: rx(String.raw`\byour\s+application\s+for\s+(?:the\s+)?${TITLE}(?:\s+(?:at|with)\s+${COMPANY})?${END}`), title: 1, company: 2, weight: 1.5 },
  // "applying for the Frontend Developer job at Contoso Labs" (covered above) and "interview for X at Y"
  { re: rx(String.raw`\b(?:interview|assessment|test|screen|challenge)\s+for\s+(?:the\s+)?${TITLE}\s+(?:${ROLE}\s+)?at\s+${COMPANY}${END}`), title: 1, company: 2, weight: 2.5 },
];

/** Phrases that name only the employer. */
const COMPANY_SENTENCES: { re: RegExp; weight: number; strict?: boolean }[] = [
  { re: rx(String.raw`\b(?:applying|applied|application|apply|interest|candidacy|career|future)\s+(?:to|at|with|in)\s+${COMPANY}${END}`), weight: 1.5 },
  { re: rx(String.raw`\bemployment\s+(?:with|at)\s+${COMPANY}${END}`), weight: 2 },
  { re: rx(String.raw`\b(?:sent|submitted)\s+to\s+${COMPANY}${END}`), weight: 2 },
  { re: rx(String.raw`\b(?:viewed|reviewed)\s+by\s+${COMPANY}${END}`), weight: 2 },
  { re: rx(String.raw`\bon\s+behalf\s+of\s+${COMPANY}${END}`), weight: 2 },
  // "assessment from HackerRank" names the tool as often as the employer.
  { re: rx(String.raw`\b(?:test|assessment|challenge|invitation|offer)\s+from\s+${COMPANY}${END}`), weight: 2, strict: true },
  { re: rx(String.raw`(?:^|\n|\.\s+)${COMPANY}\s+(?:has|have)\s+invited\s+you\b`), weight: 2.5 },
  { re: rx(String.raw`\binterview(?:ing)?\s+with\s+${COMPANY}${END}`), weight: 1.5 },
  // "I'm a recruiter at Aperture", "the hiring team at Hooli"
  { re: rx(String.raw`\b(?:recruiter|recruiting|talent\s+partner|hiring\s+manager|hiring\s+team|team|coordinator)\s+(?:at|with)\s+${COMPANY}${END}`), weight: 1.5 },
  { re: rx(String.raw`\b(?:join|joining|welcome\s+to)\s+(?:the\s+)?${COMPANY}${END}`), weight: 1, strict: true },
];

/** Subject lines: an event phrase followed by "Title", "Title at Company" or "Title - Company". */
const SUBJECT_PREFIX = String.raw`(?:application\s+(?:received|confirmation|submitted)|interview\s+(?:confirmed|confirmation|invitation|scheduled|request)|invitation\s+to\s+interview|offer\s+of\s+employment|offer\s+letter|offer|indeed\s+application|your\s+application\s+(?:for|to)|application\s+for|thank\s+you\s+for\s+(?:applying|your\s+application)|thanks\s+for\s+applying|regarding\s+your\s+application\s+(?:for|to)|update\s+on\s+(?:your\s+application\s+(?:for|to)|the))`;

// ---- collection -------------------------------------------------------------------------

/**
 * Runs `re` over `text`. When `accept` rejects a match, scanning resumes one character later
 * instead of after it: in "to the next round for the SRE role", the invalid capture starting at
 * "to" must not hide the valid one starting at "for".
 */
function scan(re: RegExp, text: string, accept: (m: RegExpExecArray) => boolean) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (let m = g.exec(text); m; m = g.exec(text)) {
    if (!accept(m)) g.lastIndex = m.index + 1;
    else if (m[0].length === 0) g.lastIndex += 1;
  }
}

/** `fromContent` is false only for the sender's own display name, which is weaker evidence. */
function add(map: Candidates, value: string | null, weight: number, fromContent = true) {
  if (!value || weight <= 0) return;
  const key = value.toLowerCase();
  const existing = map.get(key);
  if (existing) {
    existing.weight += weight;
    existing.fromContent ||= fromContent;
  } else map.set(key, { value, weight, order: map.size, fromContent });
}

function pick(map: Candidates): string | null {
  let best: Candidate | null = null;
  for (const c of map.values())
    if (!best || c.weight > best.weight || (c.weight === best.weight && c.order < best.order))
      best = c;
  // A single weak mention is not enough to assert a value.
  return best && best.weight >= 1 ? best.value : null;
}

/** Splits "A - B" / "A | B" when one side is the employer according to other evidence. */
function splitPair(text: string, isCompany: (v: string) => boolean) {
  const parts = text.split(/\s+[-–|·]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  const [a, b] = parts as [string, string];
  if (isCompany(a) && !isCompany(b)) return { company: a, title: b };
  if (isCompany(b) && !isCompany(a)) return { company: b, title: a };
  return null;
}

export function extractCompanyAndTitle(input: FieldInput): {
  company: string | null;
  title: string | null;
} {
  const titles: Candidates = new Map();
  const companies: Candidates = new Map();
  const { subject, body } = input;
  const flat = body.replace(/\s+/g, " ");
  const lines = body.split("\n").map((l) => l.trim());
  const hints = domainHints(input);
  const matchesDomain = (v: string) => hints.some((h) => compact(v) === h || (h.length >= 4 && compact(v).startsWith(h)));

  for (const h of input.titleHints ?? []) add(titles, cleanTitle(h.value), h.weight);
  for (const h of input.companyHints ?? []) add(companies, cleanCompany(h.value), h.weight);

  // Labelled fields: "Job Title: ...", "Company: ...".
  for (const line of lines) {
    const label = /^(job\s*title|position(?:\s*title)?|role|title|job|company|employer|organi[sz]ation)\s*[:\-–]\s*(.{2,100})$/i.exec(line);
    if (!label) continue;
    if (/company|employer|organi/i.test(label[1]!)) add(companies, cleanCompany(label[2], false, "label"), 4);
    else add(titles, cleanTitle(label[2], "label"), 4);
  }

  // A company capture stops at " and" (END). In "Barnes and Noble" the name continues.
  const fullCompany = (m: RegExpExecArray, group: number) => {
    const value = m[group];
    if (!value) return value;
    const end = m.index + m[0].length;
    if (!m[0].endsWith(value)) return value;
    const rest = /^\s+(?:and|&)\s+(\p{Lu}[\p{L}\p{N}'&.-]*(?:\s+\p{Lu}[\p{L}\p{N}'&.-]*){0,3})(?=\s*(?:[.,!?;:\n]|$))/u.exec(m.input.slice(end));
    return rest ? m.input.slice(m.index + m[0].length - value.length, end + rest[0].length) : value;
  };

  // Role sentences, over the hard-wrapped lines and the flattened text.
  for (const source of [subject, body, flat])
    for (const p of ROLE_SENTENCES)
      scan(p.re, source, (m) => {
        const title = cleanTitle(m[p.title]);
        if (!title) return false;
        add(titles, title, p.weight / (source === flat ? 2 : 1));
        if (p.company) add(companies, cleanCompany(fullCompany(m, p.company), false), p.weight / (source === flat ? 2 : 1));
        return true;
      });
  for (const source of [subject, body])
    for (const p of COMPANY_SENTENCES)
      scan(p.re, source, (m) => {
        const company = cleanCompany(fullCompany(m, 1), p.strict ?? false);
        add(companies, company, p.weight);
        return !!company;
      });

  // Subject templates.
  const prefixed = rx(String.raw`^(?:[^:]{0,40}:\s*)?(${SUBJECT_PREFIX})\s*([:\-–|]|\bfor\b|\bto\b)?\s*(?:the\s+)?(.+)$`).exec(subject);
  let prefixedUsed = false;
  const before = titles.size + companies.size;
  if (prefixed) {
    // Only a requisition number is metadata; "(Frontend)" or "(Remote)" is part of the title.
    const rest = prefixed[3]!.replace(REQUISITION, "").trim();
    // "... to Stripe" names the employer; "... for Data Engineer" or "...: Data Engineer" the role.
    const toEmployer = /\bto$/i.test(prefixed[1]!) || /^to$/i.test(prefixed[2] ?? "");
    const at = /^(.+?)\s+(?:job\s+)?(?:at|@|with)\s+(.+)$/i.exec(rest);
    if (at) {
      add(titles, cleanTitle(at[1]), 2.5);
      add(companies, cleanCompany(at[2]), 2.5);
    } else {
      const pair = splitPair(rest, (v) => matchesDomain(v) || companies.has(v.toLowerCase()));
      if (pair) {
        add(titles, cleanTitle(pair.title), 2.5);
        add(companies, cleanCompany(pair.company), 2.5);
      } else if (!/\s[-–|]\s/.test(rest)) {
        // A lone remainder is a title ("Application received: ML Engineer") or the employer
        // ("Your application to Stripe"); the employer reading needs corroboration.
        if (toEmployer) add(companies, cleanCompany(rest), 2);
        else add(titles, cleanTitle(rest), 2);
      }
    }
  }
  prefixedUsed = titles.size + companies.size > before;
  // "Company - Application Received - Title (Req 1)", "Company: Thank you for your application",
  // "Company - Video Interview Invitation".
  const leading = /^([^:\-–|]{2,60}?)\s*[:\-–|]\s*(?:application\s+received|thank\s+you\s+for\s+your\s+application|(?:video\s+)?interview\s+invitation|your\s+application|application\s+update)\b(?:\s*[-–|:]\s*(.+))?$/i.exec(subject);
  if (leading) {
    add(companies, cleanCompany(leading[1]), 2.5);
    if (leading[2]) add(titles, cleanTitle(leading[2]), 2.5);
  }
  const subjectAt = /^(?:[^:]{2,60}:\s*)?(.{2,100}?)\s+(?:at|@)\s+([A-Z0-9][^:]{1,60})$/.exec(subject);
  const invite = /^(?:updated\s+)?invitation:\s*(.+?)\s+@\s/i.exec(subject);
  // In a calendar invite the "@" introduces the time, not the employer.
  if (subjectAt && !prefixedUsed && !invite) {
    add(titles, cleanTitle(subjectAt[1]), 2);
    add(companies, cleanCompany(subjectAt[2]), 2);
  }
  for (const m of subject.matchAll(/\b(?:offer|application|candidacy|interview)\s+(?:from|to|at|with)\s+([A-Z0-9][^:|,]{1,60})$/gi))
    add(companies, cleanCompany(m[1]), 2);
  for (const m of subject.matchAll(/\b(?:update|news)\s+on\s+your\s+([A-Z0-9][\w&' .-]{1,40}?)\s+application\b/g))
    add(companies, cleanCompany(m[1]), 2);

  // Calendar invites: "Invitation: Robin / Hooli - Technical Interview @ ..." and an event line
  // "Technical Interview - Senior Backend Engineer".
  if (invite) {
    for (const name of invite[1]!.split(/\s*(?:\/|<>|&|\+|\bx\b|[-–|])\s*/))
      if (matchesDomain(name)) add(companies, cleanCompany(name), 3);
  }
  for (const line of lines) {
    const event = /^(?:[\w ]{0,30}\binterview|phone screen|onsite|technical screen)\s*[-–:|]\s*(.{2,100})$/i.exec(line);
    if (event) add(titles, cleanTitle(event[1]), 2);
  }

  // Job-board blocks: a company line followed by a title line (LinkedIn), or a title line followed
  // by "Company - Place" (Indeed).
  for (let i = 0; i + 1 < lines.length; i++) {
    const here = lines[i]!, next = lines[i + 1]!;
    const placeLine = /^(.{2,60}?)\s+[-–]\s+(?:[A-Z][\w .'-]+,\s*[A-Z]{2}\b|remote|hybrid|[A-Z][\w .'-]+,\s*[A-Z][a-z]+)/.exec(next);
    if (placeLine && cleanTitle(here) && !PROSE.test(here)) {
      add(titles, cleanTitle(here), 1.5);
      add(companies, cleanCompany(placeLine[1]), 1.5);
    }
    if (companies.has(here.toLowerCase()) && cleanTitle(next) && here.length <= 60) add(titles, cleanTitle(next), 1.5);
  }

  // Signatures: "Stripe Recruiting", "The Datadog Recruiting Team", "Technical Recruiter, Acme".
  for (const line of lines.slice(-8)) {
    const team = /^(?:the\s+)?(.{2,50}?)\s+(?:recruit(?:ing|ment)|talent(?:\s+acquisition)?|careers|hr|people)(?:\s+team)?$/i.exec(line);
    if (team) add(companies, cleanCompany(team[1]), 1.5);
    const role = /^(?:senior\s+|lead\s+)?(?:technical\s+)?(?:recruiter|talent\s+partner|talent\s+acquisition[\w ]*|hiring\s+manager|hr\s+[\w ]+),\s*(.{2,50})$/i.exec(line);
    if (role) add(companies, cleanCompany(role[1]), 2);
  }

  // The sender: an ATS display name is the employer; elsewhere only when it is a department
  // ("Barclays Recruitment") or the organisation the address belongs to.
  const display = input.fromName.replace(/\s+(?:via|from|on behalf of)\s+.*$/i, "").trim();
  const domain = senderDomain(input.fromAddress ?? "");
  if (display) {
    const cleaned = cleanCompany(display);
    if (cleaned) {
      if (isRecruitingSenderDomain(domain)) add(companies, cleaned, 1.5, false);
      // "Barclays Recruitment", "Contoso Careers": a hiring department names its organisation. A
      // plain organisation name ("Career Weekly") may be a newsletter, not an employer.
      else if (DEPARTMENT.test(` ${display}`)) add(companies, cleaned, 1.5, false);
    }
  }

  // The sender's own domain confirms a candidate the message itself names; it never invents one,
  // and it does not re-confirm the sender's display name (that would count one source twice).
  for (const c of companies.values()) if (c.fromContent && matchesDomain(c.value)) c.weight += 2;
  // Capitalised words in the subject that spell the sender's organisation ("Massive Dynamic").
  if (hints.length)
    for (const m of subject.matchAll(/\b([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,3})\b/g))
      for (let n = m[1]!.split(" ").length; n >= 1; n--) {
        const phrase = m[1]!.split(" ").slice(0, n).join(" ");
        if (hints.includes(compact(phrase))) add(companies, cleanCompany(phrase), 1.5);
      }

  // A title must not be the employer's own name.
  for (const key of companies.keys()) titles.delete(key);

  return { company: pick(companies), title: pick(titles) };
}
