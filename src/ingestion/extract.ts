import type { AtsKey } from "../domain/types.ts";
import type {
  ExtractedFields,
  ExtractedSignal,
  ParsedMessage,
  SignalKind,
} from "./source.ts";
import { safeField } from "./privacy.ts";

export const EXTRACTOR_VERSION = "rules-3";

/**
 * Deterministic phrase rules. Anything ambiguous yields `kind: null` so the pipeline routes it
 * to review instead of guessing. Terminal outcomes (rejection/offer) need their own strong phrase.
 */
const PHRASES: Record<SignalKind, RegExp> = {
  OFFER_RECEIVED:
    /\b(?:pleased to (?:extend|offer)|offer of employment|(?:formal |job )offer letter|we(?:'d| would) like to offer you|extend(?:ing)? (?:you )?an offer)\b/i,
  REJECTION_RECEIVED:
    /\b(?:we (?:have )?decided to (?:move|proceed) forward with (?:other|another)|will not be (?:moving|proceeding) forward|not (?:be )?(?:moving|proceeding) forward with your|(?:decided|chosen) not to (?:move|proceed) (?:forward )?with your|regret to inform you|(?:you|your application) (?:was|were|has|have) not (?:been )?selected|position has been filled|no longer (?:considering|being considered)|unfortunately,?[^.]{0,80}\b(?:other candidates|no longer|not (?:be )?(?:able|moving|proceeding|selected)|unable)\b)/i,
  INTERVIEW_SCHEDULED:
    /\b(?:interview (?:is )?(?:confirmed|scheduled)|your interview (?:with|on|at)|calendar invitation|confirm(?:ing)? your interview)\b/i,
  INTERVIEW_INVITED:
    /\b(?:invite you to (?:an? )?(?:interview|phone screen|video)|schedule (?:an? |your )?(?:interview|phone screen|call)|interview invitation|would like to (?:interview|speak with|chat)|phone screen)\b/i,
  ASSESSMENT_INVITED:
    /\b(?:online assessment|coding (?:challenge|assessment|test)|take[- ]home|technical assessment|hackerrank|codility|codesignal|assessment (?:link|invitation)|complete (?:the|an?|your) assessment)\b/i,
  CONFIRMATION_RECEIVED:
    /\b(?:thank(?:s| you) for (?:applying|your application|your interest)|received your application|application (?:has been )?(?:received|submitted)|successfully (?:submitted|applied)|your application (?:to|for|with))\b/i,
};

export function detectKind(haystack: string): {
  kind: SignalKind | null;
  reasons: string[];
} {
  const hit = (Object.keys(PHRASES) as SignalKind[]).filter((k) =>
    PHRASES[k].test(haystack),
  );
  const reasons = hit.map((k) => "phrase:" + k);
  // Boilerplate thank-you text appears inside almost every message, so it only counts alone.
  const specific = hit.filter((k) => k !== "CONFIRMATION_RECEIVED");
  if (specific.length === 0)
    return { kind: hit.length ? "CONFIRMATION_RECEIVED" : null, reasons };
  if (specific.length === 1) return { kind: specific[0]!, reasons };
  if (
    specific.length === 2 &&
    specific.includes("INTERVIEW_SCHEDULED") &&
    specific.includes("INTERVIEW_INVITED")
  ) {
    return { kind: "INTERVIEW_SCHEDULED", reasons };
  }
  return { kind: null, reasons: [...reasons, "ambiguous-kind"] };
}

// ---- ATS / URL handling -------------------------------------------------------------------

const ATS_SENDER =
  /(?:^|\.)(?:greenhouse(?:-mail)?\.io|lever\.co|myworkday(?:jobs)?\.com|ashbyhq\.com|smartrecruiters\.com|icims\.com|jobvite\.com|workable\.com)$/i;

interface AtsMatch {
  key: AtsKey;
  canonicalUrl: string;
}

function atsFromUrl(raw: string): AtsMatch | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const seg = url.pathname.split("/").filter(Boolean);
  if (
    seg.length > 12 ||
    seg.some((s) => s.length > 200) ||
    (seg[0] && !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(seg[0]))
  )
    return null;
  const make = (
    provider: string,
    tenant: string,
    requisitionId: string,
    canonicalUrl: string,
  ): AtsMatch => ({
    key: { provider, tenant: tenant.toLowerCase(), requisitionId },
    canonicalUrl,
  });

  if (
    /(?:^|\.)greenhouse\.io$/.test(host) &&
    seg[1] === "jobs" &&
    /^\d{1,20}$/.test(seg[2] ?? "")
  ) {
    return make(
      "greenhouse",
      seg[0]!,
      seg[2]!,
      `https://boards.greenhouse.io/${seg[0]}/jobs/${seg[2]}`,
    );
  }
  if (
    host === "jobs.lever.co" &&
    seg.length >= 2 &&
    /^[0-9a-f-]{8,64}$/i.test(seg[1]!)
  ) {
    return make(
      "lever",
      seg[0]!,
      seg[1]!.toLowerCase(),
      `https://jobs.lever.co/${seg[0]}/${seg[1]!.toLowerCase()}`,
    );
  }
  if (
    host === "jobs.ashbyhq.com" &&
    seg.length >= 2 &&
    /^[0-9a-f-]{8,64}$/i.test(seg[1]!)
  ) {
    return make(
      "ashby",
      seg[0]!,
      seg[1]!.toLowerCase(),
      `https://jobs.ashbyhq.com/${seg[0]}/${seg[1]!.toLowerCase()}`,
    );
  }
  if (host === "jobs.smartrecruiters.com" && seg.length >= 2) {
    const id = /^(\d{6,})/.exec(seg[1]!)?.[1];
    if (id)
      return make(
        "smartrecruiters",
        seg[0]!,
        id,
        `https://jobs.smartrecruiters.com/${seg[0]}/${id}`,
      );
  }
  if (host.endsWith(".myworkdayjobs.com")) {
    const requisition = /_([A-Za-z]*-?\d+)$/.exec(
      seg[seg.length - 1] ?? "",
    )?.[1];
    const tenant = host.split(".")[0];
    if (requisition && tenant)
      return make(
        "workday",
        tenant,
        requisition,
        `https://${host}${url.pathname.replace(/\/+$/, "")}`,
      );
  }
  return null;
}

/** Unknown hosts have no reviewed public-job URL schema; never persist a guessed signed URL. */
function genericJobUrl(raw: string): string | null {
  void raw;
  return null;
}

function findUrls(text: string): string[] {
  return (text.match(/https?:\/\/[^\s<>"'\])]+/gi) ?? []).map((u) =>
    u.replace(/[.,;:!?]+$/, ""),
  );
}

// ---- company / title ---------------------------------------------------------------------

const TITLE_NOISE =
  /\b(?:application|update|interview|invitation|assessment|offer|status|thank|confirmation|next step)\b/i;
const COMPANY_CUT =
  /\s+(?:within|by|before|on|and|for|to|please|as|is|has|we|you|your)\b.*$/i;

function cleanTitle(value: string | null | undefined): string | null {
  value = safeField(value);
  if (!value) return null;
  const title = value
    .replace(/^["'“]|["'”]$/g, "")
    .replace(/\s+(?:position|role|job)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (
    title.length < 2 ||
    title.length > 100 ||
    /https?:|@/.test(title) ||
    TITLE_NOISE.test(title)
  )
    return null;
  return title;
}

function cleanCompany(value: string | null | undefined): string | null {
  value = safeField(value);
  if (!value) return null;
  const company = value
    .replace(COMPANY_CUT, "")
    .replace(/[\s"'”)]+$/g, "")
    .replace(
      /\s+(?:careers|recruiting|recruitment|talent|jobs|hiring|team)$/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (
    company.length < 2 ||
    company.length > 80 ||
    !/^[A-Z0-9]/.test(company) ||
    /https?:|@/.test(company)
  )
    return null;
  return company;
}

const BODY = String.raw`[^\n!.?:;]{2,100}?`;
const COMPANY = String.raw`([A-Z][^!.,\n:]{1,60})`;
const AT = String.raw`\s+(?:position|role|job)?\s*(?:at|with|@)\s+`;

const P_APPLYING = new RegExp(
  String.raw`(?:your application (?:to|for|with)|appl(?:ying|ied)\s+(?:to|for|at|with))\s+(?:the\s+)?(${BODY})${AT}${COMPANY}`,
  "i",
);
const P_INTEREST = new RegExp(
  String.raw`interest in (?:the\s+)?(${BODY})${AT}${COMPANY}`,
  "i",
);
const P_STEP_FOR = new RegExp(
  String.raw`\b(?:assessment|interview|screen|challenge)\s+for\s+(?:the\s+)?(${BODY})\s+(?:position|role|job)\s+at\s+${COMPANY}`,
  "i",
);
const P_COMPANY_ONLY = new RegExp(
  String.raw`(?:thank(?:s| you) for (?:applying|your (?:application|interest))\s+(?:to|at|in|with)|your application (?:to|with)|application to)\s+(?:the\s+)?${COMPANY}`,
  "i",
);
const P_INTERVIEW_TITLE = new RegExp(
  String.raw`interview (?:for|with)\s+(?:the\s+)?(${BODY})\s+(?:position|role|job)\b`,
  "i",
);
const P_APPLICATION_FOR = new RegExp(
  String.raw`application for (?:the\s+)?(${BODY})\s+(?:position|role|job)\b`,
  "i",
);
const P_SUBJECT_AT = new RegExp(
  String.raw`^(?:[^:]{2,50}:\s*)?([^:]{2,100}?)\s+(?:at|@)\s+${COMPANY}$`,
  "i",
);

function labelled(text: string, labels: string): string | null {
  const m = new RegExp(
    String.raw`^[ \t]*(?:${labels})[ \t]*[:\-][ \t]*(.{2,100})$`,
    "im",
  ).exec(text);
  return m?.[1]?.trim() ?? null;
}

function senderCompany(message: ParsedMessage): string | null {
  const domain = message.fromAddress?.split("@")[1] ?? "";
  if (!ATS_SENDER.test(domain)) return null;
  const name = message.fromName
    .replace(/\b(?:via|from)\b.*$/i, "")
    .replace(
      /\b(?:careers?|recruit(?:ing|ment)|talent|jobs?|hiring|hr|team|notifications?|no-?reply|do not reply)\b/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (
    !name ||
    name.includes("@") ||
    /^(?:greenhouse|lever|workday|ashby|smartrecruiters|icims|jobvite|workable)$/i.test(
      name,
    )
  )
    return null;
  return cleanCompany(name);
}

function extractCompanyAndTitle(
  message: ParsedMessage,
  body: string,
  workdaySlugTitle: string | null,
) {
  const subject = message.subject;
  const both = (re: RegExp) => {
    for (const source of [subject, body]) {
      const m = re.exec(source);
      if (m) return { title: cleanTitle(m[1]), company: cleanCompany(m[2]) };
    }
    return null;
  };
  const first = (re: RegExp, source: string) => re.exec(source)?.[1];

  let title = cleanTitle(
    labelled(body, "job title|position(?: title)?|role|title"),
  );
  let company = cleanCompany(labelled(body, "company|employer|organization"));

  for (const re of [P_APPLYING, P_INTEREST, P_STEP_FOR]) {
    const found = both(re);
    if (found) {
      title ??= found.title;
      company ??= found.company;
    }
  }
  title ??=
    cleanTitle(first(P_INTERVIEW_TITLE, body)) ??
    cleanTitle(first(P_APPLICATION_FOR, body));
  for (const source of [subject, body]) {
    company ??= cleanCompany(P_COMPANY_ONLY.exec(source)?.[1]);
  }
  const fromSubject = P_SUBJECT_AT.exec(subject);
  if (fromSubject) {
    title ??= cleanTitle(fromSubject[1]);
    company ??= cleanCompany(fromSubject[2]);
  }
  title ??= cleanTitle(workdaySlugTitle);
  company ??= senderCompany(message);
  return { company, title };
}

// ---- main ---------------------------------------------------------------------------------

function extractOne(message: ParsedMessage): ExtractedSignal {
  const body = message.text;
  const { kind, reasons } = detectKind(`${message.subject}\n${body}`);

  let ats: AtsMatch | null = null;
  let workdaySlugTitle: string | null = null;
  let genericUrl: string | null = null;
  for (const url of findUrls(body)) {
    const match = atsFromUrl(url);
    if (match && !ats) {
      ats = match;
      if (match.key.provider === "workday") {
        const slug = /\/([^/]+)_[A-Za-z]*-?\d+$/.exec(match.canonicalUrl)?.[1];
        workdaySlugTitle = slug ? slug.replace(/-/g, " ") : null;
      }
    }
    genericUrl ??= match ? null : genericJobUrl(url);
  }

  const { company, title } = extractCompanyAndTitle(
    message,
    body,
    workdaySlugTitle,
  );
  // Candidate IDs identify a person, not a particular submission.
  const externalId =
    /\bapplication\s*(?:id|number|no\.?|#|ref(?:erence)?)\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9_-]{3,40})/i.exec(
      body,
    )?.[1];
  const declaredEmail =
    /^[ \t]*(?:submitted email|applicant email|application email|email used to apply)\s*:\s*([^\s<>]+@[^\s<>]+)\s*$/im
      .exec(body)?.[1]
      ?.toLowerCase() ?? null;

  const fields: ExtractedFields = {
    company,
    title,
    location: safeField(labelled(body, "location")),
    atsKey: ats?.key ?? null,
    canonicalUrl: ats?.canonicalUrl ?? genericUrl,
    // A recipient/mailbox is not proof of the contact entered in an application.
    applicantEmail:
      declaredEmail && declaredEmail.length <= 254 ? declaredEmail : null,
    externalApplicationId:
      externalId && /\d/.test(externalId) ? externalId : null,
  };
  return {
    kind,
    confidence: kind ? "HIGH" : "LOW",
    fields,
    occurredAt: message.date,
    reasons,
  };
}

export function extractSignal(message: ParsedMessage): ExtractedSignal {
  const main = extractOne(message);
  for (const text of message.alternativeTexts ?? []) {
    const alternative = extractOne({ ...message, text });
    const conflicting =
      (main.kind && alternative.kind && main.kind !== alternative.kind) ||
      alternative.reasons.includes("ambiguous-kind") ||
      main.reasons.includes("ambiguous-kind") ||
      Object.keys(main.fields).some((key) => {
        const field = key as keyof ExtractedFields;
        const a = main.fields[field],
          b = alternative.fields[field];
        return (
          a != null &&
          b != null &&
          (field === "externalApplicationId" ||
          field === "canonicalUrl" ||
          field === "atsKey"
            ? JSON.stringify(a) !== JSON.stringify(b)
            : JSON.stringify(a).toLowerCase() !==
              JSON.stringify(b).toLowerCase())
        );
      });
    if (conflicting)
      return {
        ...main,
        confidence: "LOW",
        reasons: [...main.reasons, "conflicting-alternatives"],
      };
  }
  return main;
}
