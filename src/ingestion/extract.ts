import type { AtsKey } from "../domain/types.ts";
import type {
  ExtractedFields,
  ExtractedSignal,
  ParsedMessage,
  SignalKind,
} from "./source.ts";
import { safeField } from "./privacy.ts";
import { cleanTitle, extractCompanyAndTitle } from "./fields.ts";

export const EXTRACTOR_VERSION = "rules-7";

/**
 * Canonical form for matching: typographic quotes/dashes become ASCII, invisible characters are
 * removed and Unicode spaces become plain spaces. "We’d like to offer you" (curly apostrophe)
 * and "Interview invitation" must match the same rules as their ASCII spellings.
 */
export function normalizeForMatching(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[­​-‏⁠﻿]/g, "")
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[^\S\n]/g, " ")
    .replace(/\r\n?/g, "\n");
}

/** One line: plain-text mail is hard-wrapped at ~72 columns, which splits phrases mid-sentence. */
const flatten = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Deterministic phrase rules, matched against normalized, whitespace-flattened text. Anything
 * ambiguous yields `kind: null` so the pipeline routes it to review instead of guessing.
 * Terminal outcomes (rejection/offer) need their own strong phrase.
 */
const PHRASES: Record<SignalKind, RegExp> = {
  OFFER_RECEIVED: new RegExp(
    String.raw`\b(?:` +
      [
        String.raw`(?:pleased|happy|delighted|excited|thrilled) to (?:formally )?(?:extend|offer)(?: you)?`,
        String.raw`offer of employment`,
        String.raw`employment offer`,
        String.raw`(?:formal |job |written |verbal |official )offer letter`,
        String.raw`your offer letter`,
        String.raw`we(?:'d| would) (?:like|love) to (?:formally )?offer you`,
        String.raw`extend(?:ing)? (?:you )?an? (?:formal |verbal |written )?offer`,
        String.raw`(?:verbal|formal|written) offer`,
        String.raw`congratulations[^.!?]{0,80}\boffer\b`,
        String.raw`(?:accept|review and sign) (?:the |your )?offer`,
      ].join("|") +
      String.raw`)\b`,
    "i",
  ),
  REJECTION_RECEIVED: new RegExp(
    String.raw`\b(?:` +
      [
        String.raw`we(?:'ve| have)? decided to (?:move|proceed|go|continue) (?:forward )?with (?:other|another|a different|candidates|applicants)`,
        String.raw`(?:decided|chosen|elected) to (?:pursue|progress|move forward with|proceed with|go with) (?:other|another|a different)`,
        String.raw`(?:will not|won't|wont|are not|aren't|cannot|can't) (?:be )?(?:moving|proceeding|progressing) (?:forward|further|ahead)`,
        String.raw`(?:will not|won't|wont|are not|aren't|do not|don't|cannot|can't) (?:be )?(?:moving|proceeding|progressing|taking) (?:forward |ahead |further )?(?:with )?your (?:application|candidacy|profile)`,
        String.raw`not (?:be )?(?:moving|proceeding|progressing) (?:forward )?with your`,
        String.raw`(?:decided|chosen) not to (?:move|proceed|progress|continue) (?:forward |further )?with your`,
        String.raw`not to (?:move|proceed|progress) (?:forward |further )?with your (?:application|candidacy)`,
        String.raw`regret to (?:inform|let you know|advise|tell)`,
        String.raw`(?:you|your application|your candidacy|your profile) (?:was|were|has|have|is) not (?:been )?(?:selected|successful|shortlisted)`,
        String.raw`your (?:application|candidacy) (?:was|has been|is|had been) unsuccessful`,
        String.raw`you (?:were|have been|had been) unsuccessful`,
        String.raw`(?:position|role|vacancy|job|opening) (?:has|had) (?:now )?been (?:filled|closed|cancelled|canceled)`,
        String.raw`(?:we|the team) (?:have|has) (?:filled|closed) the (?:position|role|opening)`,
        String.raw`no longer (?:considering|being considered|under consideration|in consideration|moving forward)`,
        String.raw`(?:selected|chosen|identified|offered the (?:position|role) to) (?:another|a different|other) (?:candidate|applicant)s?`,
        String.raw`(?:other|another) candidates? (?:whose|who) (?:experience|background|skills|qualifications)`,
        String.raw`(?:unable|not able) to (?:offer you (?:the |a |an )?(?:position|role|job)|move forward with your|proceed with your|progress your)`,
        String.raw`not (?:the right|a) (?:fit|match) (?:for|at) this (?:time|role|position)`,
        String.raw`unfortunately,?[^.]{0,80}\b(?:other candidates|other applicants|no longer|not (?:be )?(?:able|moving|proceeding|progressing|selected|successful|offering)|unable|not been selected|unsuccessful)\b`,
      ].join("|") +
      String.raw`)`,
    "i",
  ),
  INTERVIEW_SCHEDULED: new RegExp(
    String.raw`\b(?:` +
      [
        String.raw`interview (?:has been |is |was )?(?:confirmed|scheduled|booked|rescheduled|set)`,
        String.raw`your (?:upcoming |scheduled |next )?(?:onsite |on-site |phone |video |virtual |technical |final |panel )?interview (?:with|on|at|for|is|tomorrow|today)`,
        // "Your onsite interview for the Mechanical Engineer position is confirmed for Monday"
        String.raw`interview\b[^.!?\n]{0,100}\b(?:is|has been|was|are|have been) (?:now )?(?:confirmed|scheduled|booked|set)`,
        String.raw`calendar invitation`,
        String.raw`confirm(?:ing|ed)? (?:your|the) interview`,
        String.raw`interview (?:details|confirmation|reminder)`,
        String.raw`reminder:? (?:your |upcoming )?interview`,
        String.raw`looking forward to (?:your |our |the )?interview`,
        // Google/Outlook calendar invites: "Invitation: Interview with Acme @ Tue Oct 13, 10am".
        String.raw`(?:updated )?invitation: [^@.!?]{0,80}\binterview\b[^@.!?]{0,80} @ `,
      ].join("|") +
      String.raw`)\b`,
    "i",
  ),
  INTERVIEW_INVITED: new RegExp(
    String.raw`\b(?:` +
      [
        String.raw`invite you (?:to|for) (?:an? |the |your )?(?:first[- ]round |initial |technical |final |video |virtual |phone |onsite |on-site )?(?:interview|phone screen|video|call|conversation|chat|meeting|next (?:round|stage|step))`,
        String.raw`invitation to (?:an? )?(?:interview|phone screen)`,
        String.raw`(?:schedule|book|arrange|set up|organize|organise) (?:an? |your |the |some )?(?:first[- ]round |initial |technical |final |video |virtual |phone |quick |brief |short )?(?:interview|phone screen|call|chat|time to (?:talk|chat|speak|meet)|conversation)`,
        String.raw`interview invitation`,
        String.raw`invite(?:d)? you to (?:complete|take|schedule|record|attend) (?:an? |your |the )?(?:one-way |recorded |video |virtual |online |phone |first |initial )*interview`,
        String.raw`would (?:like|love) to (?:interview|speak with|talk with|talk to|chat|meet|set up)`,
        String.raw`phone screen`,
        String.raw`(?:move|moving|advance|advancing|progress) (?:you )?(?:forward )?to (?:the )?(?:next|interview|first|second|final) (?:round|stage|step)`,
        String.raw`(?:share|send|provide|let us know) (?:your|some) (?:availability|available times)`,
        String.raw`(?:your|some) availability for (?:an? )?(?:interview|call|chat|conversation)`,
        String.raw`(?:pick|select|choose|book) a (?:time|slot)`,
      ].join("|") +
      String.raw`)\b`,
    "i",
  ),
  ASSESSMENT_INVITED: new RegExp(
    String.raw`\b(?:` +
      [
        String.raw`online (?:assessment|test|exercise)`,
        String.raw`coding (?:challenge|assessment|test|exercise|assignment)`,
        String.raw`take[- ]home (?:assignment|exercise|challenge|test|project|task)?`,
        String.raw`technical (?:assessment|challenge|exercise|test|assignment)`,
        String.raw`skills? (?:assessment|test)`,
        // HireVue is mostly one-way video interviews, so it is not an assessment signal by itself.
        String.raw`hackerrank|codility|codesignal|testgorilla|coderbyte`,
        String.raw`assessment (?:link|invitation|invite)`,
        String.raw`(?:complete|take|start|finish) (?:the|an?|your|our) (?:online |technical |short |brief )?(?:assessment|test|challenge|exercise)`,
        String.raw`invited to (?:complete|take) (?:an? |the )?(?:assessment|test|challenge)`,
      ].join("|") +
      String.raw`)\b`,
    "i",
  ),
  // Only phrases that say an application was actually received or submitted. Courtesy lines such
  // as "thank you for your interest" also open talent-community and newsletter mail.
  CONFIRMATION_RECEIVED: new RegExp(
    String.raw`\b(?:` +
      [
        String.raw`thank(?:s| you) (?:so much |very much )?for (?:applying|your application|submitting|your submission)`,
        String.raw`(?:received|receiving|got) your (?:job )?application`,
        String.raw`(?:your )?application (?:has been |was |is |had been )?(?:successfully )?(?:received|submitted|sent)`,
        String.raw`successfully (?:submitted|applied|received)`,
        String.raw`you(?:'ve| have)? (?:successfully )?applied (?:to|for)`,
        String.raw`application (?:confirmation|acknowledg(?:e)?ment)`,
        String.raw`confirm(?:ing)? (?:the )?receipt of your`,
      ].join("|") +
      String.raw`)\b`,
    "i",
  ),
};

// Only wording about the application itself. Receipts carry footers such as "join our talent
// community" or "if you have not yet completed your profile", which must not veto them.
const NOT_SUBMITTED =
  /\bapplication\b[^.!?\n]{0,60}\b(?:has not|hasn'?t|is not|isn'?t|was not|wasn'?t)\s+(?:yet\s+)?(?:been\s+)?(?:submitted|finished|completed)\b|\b(?:haven'?t|have not|not yet)\s+(?:yet\s+)?(?:submitted|finished|completed)\s+(?:it|your application|the application)\b|\bsaved as (?:a )?draft\b|\b(?:complete|finish) your application\b|\bstarted (?:an|your) application\b|\bincomplete application\b/i;

const STEP_KINDS: ReadonlySet<SignalKind> = new Set<SignalKind>([
  "ASSESSMENT_INVITED",
  "INTERVIEW_INVITED",
  "INTERVIEW_SCHEDULED",
]);

export function detectKind(haystack: string): {
  kind: SignalKind | null;
  reasons: string[];
} {
  const flat = flatten(normalizeForMatching(haystack));
  // "Thank you for taking the time to interview with us" opens most post-interview rejections;
  // a thank-you sentence describes the past, so it never proposes an interview/assessment step.
  const withoutThanks = flat.replace(
    /\bthank(?:s| you)(?: (?:so|very) much)? for (?:taking (?:the )?time|your time|interviewing|your (?:recent )?interview|meeting|speaking|talking|chatting|completing|the opportunity|participating|attending|your patience)[^.!?\n]{0,200}[.!?]?/gi,
    " ",
  );
  const hit = (Object.keys(PHRASES) as SignalKind[]).filter((k) =>
    PHRASES[k].test(STEP_KINDS.has(k) ? withoutThanks : flat),
  );
  const reasons = hit.map((k) => "phrase:" + k);
  // Boilerplate thank-you text appears inside almost every message, so it only counts alone.
  const specific = hit.filter((k) => k !== "CONFIRMATION_RECEIVED");
  if (specific.length === 0) {
    // A saved draft, an unfinished form or a talent-community sign-up is not a submission.
    if (hit.length && NOT_SUBMITTED.test(flat))
      return { kind: null, reasons: [...reasons, "not-submitted"] };
    return { kind: hit.length ? "CONFIRMATION_RECEIVED" : null, reasons };
  }
  if (specific.length === 1) return { kind: specific[0]!, reasons };
  if (
    specific.length === 2 &&
    specific.includes("INTERVIEW_SCHEDULED") &&
    specific.includes("INTERVIEW_INVITED")
  ) {
    return { kind: "INTERVIEW_SCHEDULED", reasons };
  }
  // "Following your interview ... we have decided to move forward with other candidates": a
  // rejection that mentions earlier steps. Propose it, but marked so a human must confirm it.
  if (
    specific.includes("REJECTION_RECEIVED") &&
    !specific.includes("OFFER_RECEIVED") &&
    specific.every((k) => k === "REJECTION_RECEIVED" || STEP_KINDS.has(k))
  ) {
    return { kind: "REJECTION_RECEIVED", reasons: [...reasons, "mixed-kind"] };
  }
  return { kind: null, reasons: [...reasons, "ambiguous-kind"] };
}

// ---- ATS / URL handling -------------------------------------------------------------------

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
    (host === "jobs.lever.co" || host === "jobs.eu.lever.co") &&
    seg.length >= 2 &&
    /^[0-9a-f-]{8,64}$/i.test(seg[1]!)
  ) {
    return make(
      "lever",
      seg[0]!,
      seg[1]!.toLowerCase(),
      `https://${host}/${seg[0]}/${seg[1]!.toLowerCase()}`,
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
    const jobIndex = seg.indexOf("job");
    // Only the public locale/board/job/location/title schema is canonical.
    // Arbitrary account/tracking paths must never become stored "job URLs".
    if (
      (jobIndex !== 1 && jobIndex !== 2) ||
      (jobIndex === 2 && !/^[a-z]{2}-[a-z]{2}$/i.test(seg[0]!)) ||
      seg.length !== jobIndex + 3 ||
      !/^[a-z0-9_-]{1,80}$/i.test(seg[jobIndex - 1]!)
    ) return null;
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

// ---- labelled values -------------------------------------------------------------------

function labelled(text: string, labels: string): string | null {
  const m = new RegExp(
    String.raw`^[ \t]*(?:${labels})[ \t]*[:\-][ \t]*(.{2,100})$`,
    "im",
  ).exec(text);
  return m?.[1]?.trim() ?? null;
}

/** A job requisition is employer-scoped; Candidate ID must never identify a submission. */
function ibmJobDetails(message: ParsedMessage, body: string) {
  if (!/@ibm\.com$/i.test(message.fromAddress ?? "")) return null;
  const subject = /^you have successfully submitted your IBM job application\s*-\s*(\d{4,10})\s*-\s*(.{2,100})$/i.exec(message.subject);
  const sentence = /applying to the role of\s+(.{2,100}?)\s*-\s*(\d{4,10})\s+with Candidate ID\s*-\s*\d+\s+at IBM\b/i.exec(body);
  const reference = /(?:^|\n)\s*Ref\s*:\s*(\d{4,10})\s*-\s*([^\n|]{2,100})/i.exec(body);
  const candidates = [
    subject && { id: subject[1]!, title: cleanTitle(subject[2]) },
    sentence && { id: sentence[2]!, title: cleanTitle(sentence[1]) },
    reference && { id: reference[1]!, title: cleanTitle(reference[2]) },
  ].filter((c): c is { id: string; title: string | null } => !!c);
  if (!candidates.length) return null;
  const first = candidates[0]!;
  const conflict = candidates.some(c => c.id !== first.id ||
    (c.title && first.title && c.title.toLowerCase() !== first.title.toLowerCase()));
  return { id: first.id, title: first.title, conflict };
}

// ---- main ---------------------------------------------------------------------------------

function extractOne(raw: ParsedMessage): ExtractedSignal {
  const message: ParsedMessage = {
    ...raw,
    subject: normalizeForMatching(raw.subject).replace(/\s+/g, " ").trim(),
    fromName: normalizeForMatching(raw.fromName).replace(/\s+/g, " ").trim(),
  };
  const body = normalizeForMatching(raw.text);
  const { kind, reasons } = detectKind(`${message.subject}\n${body}`);

  let ats: AtsMatch | null = null;
  let workdaySlugTitle: string | null = null;
  let genericUrl: string | null = null;
  const jobLinks = new Set<string>();
  const ibm = ibmJobDetails(message, body);
  if (ibm && !ibm.conflict) {
    ats = { key: { provider: "ibm", tenant: "ibm", requisitionId: ibm.id }, canonicalUrl: "" };
    jobLinks.add(JSON.stringify(ats.key));
  }
  for (const url of findUrls(body)) {
    const match = atsFromUrl(url);
    if (match) jobLinks.add(JSON.stringify(match.key));
    if (match && !ats) {
      ats = match;
      if (match.key.provider === "workday") {
        const slug = /\/([^/]+)_[A-Za-z]*-?\d+$/.exec(match.canonicalUrl)?.[1];
        workdaySlugTitle = slug ? slug.replace(/-/g, " ") : null;
      }
    }
    genericUrl ??= match ? null : genericJobUrl(url);
  }

  const { company, title } = extractCompanyAndTitle({
    subject: message.subject,
    fromName: message.fromName,
    fromAddress: message.fromAddress,
    body,
    titleHints: [
      ...(workdaySlugTitle ? [{ value: workdaySlugTitle, weight: 1 }] : []),
      ...(ibm && !ibm.conflict && ibm.title ? [{ value: ibm.title, weight: 3 }] : []),
    ],
    companyHints: ibm && !ibm.conflict ? [{ value: "IBM", weight: 3 }] : [],
  });
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
    canonicalUrl: ats?.canonicalUrl || genericUrl,
    // A recipient/mailbox is not proof of the contact entered in an application.
    applicantEmail:
      declaredEmail && declaredEmail.length <= 254 ? declaredEmail : null,
    externalApplicationId:
      externalId && /\d/.test(externalId) ? externalId : null,
  };
  if (jobLinks.size > 1 || ibm?.conflict) {
    fields.atsKey = null;
    fields.canonicalUrl = null;
    reasons.push("ambiguous-job-links");
  }
  return {
    kind,
    confidence: kind && !reasons.includes("mixed-kind") && jobLinks.size <= 1 && !ibm?.conflict ? "HIGH" : "LOW",
    fields,
    occurredAt: message.date,
    reasons,
  };
}

const STRICT_FIELDS: ReadonlySet<keyof ExtractedFields> = new Set([
  "externalApplicationId",
  "canonicalUrl",
  "atsKey",
]);

function conflicts(a: ExtractedSignal, b: ExtractedSignal): boolean {
  if (a.kind && b.kind && a.kind !== b.kind) return true;
  if (a.reasons.includes("ambiguous-kind") || b.reasons.includes("ambiguous-kind"))
    return true;
  return (Object.keys(a.fields) as (keyof ExtractedFields)[]).some((field) => {
    const x = a.fields[field],
      y = b.fields[field];
    if (x == null || y == null) return false;
    return STRICT_FIELDS.has(field)
      ? JSON.stringify(x) !== JSON.stringify(y)
      : JSON.stringify(x).toLowerCase() !== JSON.stringify(y).toLowerCase();
  });
}

/**
 * Combines the primary text with the other MIME alternatives. Many ATS mails ship a stub
 * text/plain part ("view this email in a browser") next to the real HTML, so a signal found only
 * in an alternative is used, and missing fields are filled from it. Any disagreement between
 * representations still forces review.
 */
export function extractSignal(message: ParsedMessage): ExtractedSignal {
  let merged = extractOne(message);
  for (const text of message.alternativeTexts ?? []) {
    const alternative = extractOne({ ...message, text });
    if (conflicts(merged, alternative))
      return {
        ...merged,
        confidence: "LOW",
        reasons: [...merged.reasons, "conflicting-alternatives"],
      };
    const fields = { ...merged.fields };
    for (const key of Object.keys(fields) as (keyof ExtractedFields)[])
      if (fields[key] == null)
        (fields as Record<string, unknown>)[key] = alternative.fields[key];
    const kind = merged.kind ?? alternative.kind;
    const reasons = [...new Set([...merged.reasons, ...alternative.reasons])];
    merged = {
      ...merged,
      kind,
      fields,
      reasons,
      confidence: kind && !reasons.includes("mixed-kind") && !reasons.includes("ambiguous-job-links") ? "HIGH" : "LOW",
    };
  }
  return merged;
}
