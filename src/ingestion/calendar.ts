import { createHash } from "node:crypto";
import ICAL from "ical.js";
import type { CalendarFacts, ParsedMessage } from "./source.ts";

interface CalendarEvent {
  facts: CalendarFacts;
  summary: string;
  description: string;
  organizer: string;
}

/** Any structural surprise rejects the part; the caller turns it into "uncertain-calendar". */
class Unusable extends Error {}
const ensure = (condition: unknown): void => {
  if (!condition) throw new Unusable();
};

const MAX_BYTES = 100_000;
const MAX_LINES = 4000;
const MAX_DEPTH = 20;
const INTERVIEW_SUMMARY =
  /\b(?:interview|phone screen|technical screen|onsite)\b/i;
const SINGLE_VALUED = [
  "uid",
  "sequence",
  "dtstart",
  "status",
  "summary",
  "organizer",
];

/** Size and BEGIN/END nesting are checked before ical.js sees the text. */
function checkBounds(content: string): void {
  const lines = content.split(/\r?\n/);
  ensure(content.length <= MAX_BYTES && lines.length <= MAX_LINES);
  let depth = 0;
  for (const line of lines) {
    if (/^BEGIN:/i.test(line)) ensure(++depth <= MAX_DEPTH);
    if (/^END:/i.test(line)) ensure(--depth >= 0);
  }
  ensure(depth === 0);
}

const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/** ical.js accepts out-of-range components ("2026-02-31T25:00"); a real start time does not. */
function checkClock(time: unknown): void {
  if (!(time instanceof ICAL.Time)) return;
  ensure(time.month >= 1 && time.month <= 12);
  ensure(time.day >= 1 && time.day <= daysInMonth(time.year, time.month));
  ensure(time.hour >= 0 && time.hour <= 23);
  ensure(time.minute >= 0 && time.minute <= 59);
  ensure(time.second >= 0 && time.second <= 59);
}

/**
 * The start as an instant, or null when it is not one: an all-day date, a floating local time,
 * or a TZID with no VTIMEZONE in the file (remote time zones are never loaded).
 */
function absoluteStart(
  root: ICAL.Component,
  event: ICAL.Component,
): string | null {
  const time = event.getFirstPropertyValue("dtstart");
  checkClock(time);
  if (!(time instanceof ICAL.Time) || time.isDate) return null;
  const tzid = event.getFirstProperty("dtstart")?.getParameter("tzid");
  const absolute =
    tzid == null
      ? time.zone === ICAL.Timezone.utcTimezone
      : typeof tzid === "string" &&
        time.zone !== ICAL.Timezone.utcTimezone &&
        !!root.getTimeZoneByID(tzid);
  return absolute ? new Date(time.toUnixTime() * 1000).toISOString() : null;
}

/** Parses one part. Returns null for a well-formed invitation that is not about an interview. */
function parsePart(
  part: { method: string | null; content: string },
  reasons: string[],
): CalendarEvent | null {
  checkBounds(part.content);
  const root = ICAL.Component.fromString(part.content);
  ensure(
    root.name === "vcalendar" && root.getAllProperties("method").length === 1,
  );
  const method = String(root.getFirstPropertyValue("method")).toUpperCase();
  // The MIME part's method parameter must agree with the calendar's own METHOD.
  ensure(
    part.method &&
      method === part.method &&
      ["REQUEST", "CANCEL"].includes(method),
  );

  const events = root.getAllSubcomponents("vevent");
  ensure(events.length === 1);
  const event = events[0]!;
  const summary = String(event.getFirstPropertyValue("summary") ?? "");
  if (!INTERVIEW_SUMMARY.test(summary)) return null;
  for (const name of SINGLE_VALUED)
    ensure(event.getAllProperties(name).length <= 1);
  // Recurring interviews are not modelled; expanding them is unbounded work.
  ensure(!event.hasProperty("rrule") && !event.hasProperty("recurrence-id"));

  const uid = event.getFirstPropertyValue("uid");
  const sequence = Number(event.getFirstPropertyValue("sequence") ?? 0);
  ensure(typeof uid === "string" && uid && uid.length <= 512);
  ensure(Number.isSafeInteger(sequence) && sequence >= 0);
  const status = String(
    event.getFirstPropertyValue("status") ?? "",
  ).toUpperCase();
  const scheduledFor = absoluteStart(root, event);
  const organizer = String(
    event.getFirstPropertyValue("organizer") ?? "",
  ).replace(/^mailto:/i, "");
  const organizerDomain =
    /^[^\s<>@]+@([A-Za-z0-9.-]+)$/.exec(organizer)?.[1]?.toLowerCase() ?? null;

  if (method === "CANCEL" || status === "CANCELLED")
    reasons.push("interview-cancelled");
  else if (!scheduledFor || !["", "CONFIRMED"].includes(status))
    reasons.push("uncertain-calendar");
  return {
    // The UID is hashed: raw calendar identifiers are never retained.
    facts: {
      uidKey: createHash("sha256")
        .update(uid as string)
        .digest("hex"),
      sequence,
      method,
      status,
      scheduledFor,
      organizerDomain,
    },
    summary,
    description: String(event.getFirstPropertyValue("description") ?? ""),
    organizer,
  };
}

/** Parse bounded scheduling data without expanding recurrences or loading remote time zones. */
export function extractCalendar(message: ParsedMessage): {
  event: CalendarEvent | null;
  reasons: string[];
} {
  const events: CalendarEvent[] = [];
  const reasons: string[] = [];
  for (const part of message.calendarParts ?? []) {
    try {
      const event = parsePart(part, reasons);
      if (event) events.push(event);
    } catch {
      // Unusable, or anything ical.js throws on malformed input.
      reasons.push("uncertain-calendar");
    }
  }
  // Several parts describing different events cannot be reconciled automatically.
  const unique = new Map(
    events.map((event) => [JSON.stringify(event.facts), event]),
  );
  if (unique.size > 1) reasons.push("uncertain-calendar");
  return {
    event: unique.size === 1 ? [...unique.values()][0]! : null,
    reasons: [...new Set(reasons)],
  };
}
