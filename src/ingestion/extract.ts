import type { AtsKey } from "../domain/types.ts";
import type {
  ExtractedFields,
  ExtractedSignal,
  ParsedMessage,
  SignalKind,
} from "./source.ts";
import { safeField } from "./privacy.ts";
import { cleanTitle, extractCompanyAndTitle } from "./fields.ts";
import { messageRegions } from "./regions.ts";
import { extractCalendar } from "./calendar.ts";
import { companyKey } from "../domain/normalization.ts";

export const EXTRACTOR_VERSION = "rules-8";

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
        // "Your interview on Tuesday", "your upcoming interview with Acme". Not "your final interview
        // for X", which can continue "has been cancelled" or "will be scheduled once ...".
        String.raw`your (?:upcoming |scheduled )(?:onsite |on-site |phone |video |virtual |technical |final |panel )?interview\b`,
        String.raw`your (?:onsite |on-site |phone |video |virtual |technical |final |panel )?interview (?:with|on|at|tomorrow|today)\b`,
        // "Your onsite interview for the Mechanical Engineer position is confirmed for Monday"
        String.raw`interview\b[^.!?\n]{0,100}\b(?:is|has been|was|are|have been) (?:now )?(?:confirmed|scheduled|booked|set)`,
        // The next sentence refers back to the interview: "...your interview for X. It is now
        // scheduled for Thursday", "...the interview. This call has been booked for 3 PM".
        String.raw`interview\b[^.!?]{0,160}[.!?]\s+(?:(?:this|that|the) (?:call|meeting|session|interview|appointment)|it|this|that)(?: is|'s| has been| was) (?:now )?(?:confirmed|scheduled|booked|set|rescheduled|moved) (?:for|to|on|at)\b`,
        // "We have moved your interview to Friday", "your interview time has changed to 2 PM".
        String.raw`(?:moved|rescheduled|changed) (?:your|the) (?:[\w-]+ )?interview (?:to|for)\b`,
        String.raw`interview (?:time |date |slot )?(?:has been |was |is )?(?:moved|changed|rescheduled) to\b`,
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
        String.raw`(?:share|send|provide|let us know)(?: us| me)? (?:your|some) (?:availability|available times)`,
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

/** Negated receipts: "we have not received your application", "did not receive your application". */
const NOT_RECEIVED =
  /\b(?:have not|haven'?t|has not|hasn'?t|did not|didn'?t|do not|don'?t|not yet|never|were unable to|could not|couldn'?t)\s+(?:yet\s+)?(?:been\s+)?(?:receive|received|get|got|find|found|locate|located)\s+(?:a |an |your |the )?(?:completed |job )?application\b/i;

/** The interview was called off; there is no event type for that, so a person decides. */
const INTERVIEW_CANCELLED =
  /\binterview\b[^.!?\n]{0,120}\b(?:has been|have been|was|were|is|are|been)\s+(?:cancell?ed|called off|postponed|withdrawn)\b|\b(?:cancel(?:l?ed|ling)?|call(?:ed|ing)? off|postpon(?:e|ed|ing))\s+(?:your|the|our)\s+(?:[\w-]+\s+){0,2}interview\b|\binterview\s+cancell?ation\b/i;

/** The interview has not been fixed yet: "will be scheduled once you send your availability". */
const INTERVIEW_NOT_YET_SCHEDULED =
  /\binterview\b[^.!?\n]{0,120}\b(?:will be|to be|would be|can be|is not yet|has not (?:yet )?been|not yet)\s+(?:scheduled|confirmed|booked|set up)\b/i;

const STEP_KINDS: ReadonlySet<SignalKind> = new Set<SignalKind>([
  "ASSESSMENT_INVITED",
  "INTERVIEW_INVITED",
  "INTERVIEW_SCHEDULED",
]);

export function detectKind(haystack: string): {
  kind: SignalKind | null;
  reasons: string[];
} {
  // Phrases are prose: a hostname in a link ("www.hackerrank.com/...") is not a mention.
  const normalized = normalizeForMatching(haystack).replace(/https?:\/\/\S+/gi, " ");
  // Keep assertion boundaries; ordinary hard wrapping may still join within a clause.
  const clauses = normalized.split(/(?:[.!?]+(?:\s+|$)|\n{2,}|\n(?=\s*(?:if|unless|should|in case|when)\b))/i)
    .map(flatten).filter(clause => clause && !/^(?:if|unless|should|in case|when)\b/i.test(clause));
  // "Thank you for taking the time to interview with us" opens most post-interview rejections;
  // a thank-you sentence describes the past, so it never proposes an interview/assessment step.
  const withoutThanks = clauses.map(clause => clause.replace(
    /\bthank(?:s| you)(?: (?:so|very) much)? for (?:taking (?:the )?time|your time|interviewing|your (?:recent )?interview|meeting|speaking|talking|chatting|completing|the opportunity|participating|attending|your patience)[^.!?\n]{0,200}[.!?]?/gi,
    " ",
  ));
  if (withoutThanks.some(clause => INTERVIEW_CANCELLED.test(clause)))
    return { kind: null, reasons: ["interview-cancelled"] };
  const notYetScheduled = withoutThanks.some(clause => INTERVIEW_NOT_YET_SCHEDULED.test(clause));
  const negatedReceipt = clauses.some(clause => NOT_SUBMITTED.test(clause) || NOT_RECEIVED.test(clause));
  const hit = (Object.keys(PHRASES) as SignalKind[]).filter(
    k => (STEP_KINDS.has(k) ? withoutThanks : clauses).some(clause =>
      !(k === "INTERVIEW_SCHEDULED" && INTERVIEW_NOT_YET_SCHEDULED.test(clause)) &&
      !(k === "CONFIRMATION_RECEIVED" && (NOT_SUBMITTED.test(clause) || NOT_RECEIVED.test(clause))) && PHRASES[k].test(clause)),
  );
  // Only an explicit referent can connect adjacent sentences; no other rule borrows a noun
  // from a subject or previous assertion to give an unrelated clause its event meaning.
  for (let i = 0; i + 1 < withoutThanks.length; i++) {
    const before = withoutThanks[i]!, after = withoutThanks[i + 1]!;
    if (/\binterview\b/i.test(before) && /^(?:(?:this|that|the) (?:call|meeting|session|interview|appointment)|it|this|that)(?: is|'s| has been| was) (?:now )?(?:confirmed|scheduled|booked|set|rescheduled|moved) (?:for|to|on|at)\b/i.test(after) &&
        !INTERVIEW_NOT_YET_SCHEDULED.test(before) && !hit.includes("INTERVIEW_SCHEDULED")) hit.push("INTERVIEW_SCHEDULED");
  }
  const reasons = hit.map((k) => "phrase:" + k);
  if (notYetScheduled) reasons.push("interview-not-yet-scheduled");
  // Boilerplate thank-you text appears inside almost every message, so it only counts alone.
  const specific = hit.filter((k) => k !== "CONFIRMATION_RECEIVED");
  if (specific.length === 0) {
    // A saved draft, an unfinished form or a receipt that says nothing arrived is not a
    // submission. The pipeline sends these to review: they still concern an application.
    if (negatedReceipt)
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

function extractOne(
  raw: ParsedMessage,
  calendar: ReturnType<typeof extractCalendar>,
  calendarFields: ReturnType<typeof extractCompanyAndTitle> | null,
): ExtractedSignal {
  const message: ParsedMessage = {
    ...raw,
    subject: normalizeForMatching(raw.subject).replace(/\s+/g, " ").trim(),
    fromName: normalizeForMatching(raw.fromName).replace(/\s+/g, " ").trim(),
  };
  const regions = messageRegions(normalizeForMatching(raw.text));
  const body = regions.current;
  const detected = detectKind(`${message.subject}.\n${body}`);
  let { kind } = detected;
  const reasons = detected.reasons;
  if (/^\s*re\s*:/i.test(message.subject) && !detectKind(body).kind) {
    kind = null;
    reasons.push(regions.hasQuotedHistory ? "quoted-history-only" : "reply-subject-only");
  }
  reasons.push(...calendar.reasons);
  if (calendar.reasons.includes("interview-cancelled")) kind = null;
  else if (calendar.event && !calendar.reasons.length) {
    if (!kind || STEP_KINDS.has(kind)) kind = "INTERVIEW_SCHEDULED";
    else reasons.push("uncertain-calendar");
  }

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

  const { company, title, decisions } = extractCompanyAndTitle({
    subject: message.subject.replace(/^(?:\s*re\s*:\s*)+/i,""),
    fromName: message.fromName,
    fromAddress: message.fromAddress,
    body,
    signature: regions.signature,
    titleHints: [
      ...(calendarFields?.title ? [{ value: calendarFields.title, weight: 3 }] : []),
      ...(workdaySlugTitle ? [{ value: workdaySlugTitle, weight: 1 }] : []),
      ...(ibm && !ibm.conflict && ibm.title ? [{ value: ibm.title, weight: 3 }] : []),
    ],
    companyHints: [
      ...(ibm && !ibm.conflict ? [{ value: "IBM", weight: 3 }] : []),
      ...(calendarFields?.company ? [{ value: calendarFields.company, weight: 3 }] : []),
    ],
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
    fieldDecisions: decisions,
    ...(calendar.event ? { calendar: calendar.event.facts } : {}),
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
  if (Object.values(decisions).some(d => d.state === "AMBIGUOUS")) reasons.push("conflicting-fields");
  if (calendarFields && Object.values(calendarFields.decisions).some(d => d.state === "AMBIGUOUS")) reasons.push("conflicting-fields");
  return {
    kind,
    confidence: kind && !reasons.includes("mixed-kind") && !reasons.includes("conflicting-fields") && !reasons.includes("uncertain-calendar") && jobLinks.size <= 1 && !ibm?.conflict ? "HIGH" : "LOW",
    fields,
    occurredAt: message.date,
    reasons,
  };
}

/** Reasons that concern an application even though no event kind was assigned. */
const HIRING_REASONS: ReadonlySet<string> = new Set([
  "interview-cancelled",
  "not-submitted",
  "ambiguous-kind",
  "uncertain-calendar",
]);

/** Whether a message is about an application at all, as opposed to account or other mail. */
export const isHiringSignal = (signal: ExtractedSignal): boolean =>
  signal.kind !== null || signal.reasons.some((reason) => HIRING_REASONS.has(reason));

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
    if (field === "fieldDecisions" || field === "company" || field === "title") return false;
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
  const calendar = extractCalendar(message);
  const calendarFields = calendar.event ? extractCompanyAndTitle({
    subject: calendar.event.summary,
    body: `${calendar.event.summary}\n${calendar.event.description}\nOrganizer: ${calendar.event.organizer}`,
    fromName: normalizeForMatching(message.fromName), fromAddress: message.fromAddress,
  }) : null;
  const representations = [...new Set([message.text, ...(message.alternativeTexts ?? [])])]
    .map(text => extractOne({ ...message, text }, calendar, calendarFields));
  const primary = representations[0]!;
  const fields = { ...primary.fields };
  const reasons = new Set(representations.flatMap(signal => signal.reasons));
  if (representations.some(signal => conflicts(primary, signal))) reasons.add("conflicting-alternatives");
  // Alternatives are correlated renderings, not independent votes. Keep the strongest support
  // for each value and retain ambiguity from every representation, regardless of MIME ordering.
  fields.fieldDecisions = { ...primary.fields.fieldDecisions! };
  for (const key of ["company", "title"] as const) {
    const decisions = representations.map(signal => signal.fields.fieldDecisions![key]);
    const keyOf = (value: string) => key === "company" ? companyKey(value) : value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
    const supported = new Map(decisions.filter(d => d.state === "SUPPORTED" && d.value).map(d => [keyOf(d.value!), d.value!]));
    const candidates = new Map<string, (typeof decisions)[number]["candidates"][number]>();
    for (const decision of decisions) for (const candidate of decision.candidates) {
      const id = keyOf(candidate.value), existing = candidates.get(id);
      if (!existing || candidate.score > existing.score) candidates.set(id, candidate);
    }
    const ambiguous = decisions.some(d => d.state === "AMBIGUOUS") || supported.size > 1;
    const value = ambiguous ? null : supported.values().next().value ?? null;
    fields[key] = value;
    fields.fieldDecisions[key] = {
      state: ambiguous ? "AMBIGUOUS" : value ? "SUPPORTED" : "MISSING", value,
      candidates: [...candidates.values()].sort((a, b) => b.score - a.score || a.value.localeCompare(b.value)).slice(0, 8),
    };
    if (ambiguous) reasons.add("conflicting-fields");
    if (supported.size > 1) reasons.add("conflicting-alternatives");
  }
  for (const key of ["location", "atsKey", "canonicalUrl", "applicantEmail", "externalApplicationId"] as const) {
    const present = representations.map(signal => signal.fields[key]).filter(value => value != null);
    const distinct = new Set(present.map(value => STRICT_FIELDS.has(key) ? JSON.stringify(value) : JSON.stringify(value).toLowerCase()));
    if (distinct.size > 1) {
      fields[key] = null;
      reasons.add("conflicting-alternatives");
    } else (fields as Record<string, unknown>)[key] = present[0] ?? null;
  }
  const kinds = new Set(representations.map(signal => signal.kind).filter(kind => kind !== null));
  if (kinds.size > 1) reasons.add("conflicting-alternatives");
  const kind = kinds.size === 1 ? [...kinds][0]! : null;
  const uncertain = ["mixed-kind", "ambiguous-kind", "ambiguous-job-links", "conflicting-fields", "conflicting-alternatives", "uncertain-calendar"];
  return { ...primary, kind, fields, reasons: [...reasons], confidence: kind && !uncertain.some(reason => reasons.has(reason)) ? "HIGH" : "LOW" };
}
