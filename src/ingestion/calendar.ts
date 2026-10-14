import { createHash } from "node:crypto";
import ICAL from "ical.js";
import type { CalendarFacts, ParsedMessage } from "./source.ts";

interface CalendarEvent {
  facts: CalendarFacts;
  summary: string;
  description: string;
  organizer: string;
}

/** Parse bounded scheduling data without expanding recurrences or loading remote time zones. */
export function extractCalendar(message: ParsedMessage): { event: CalendarEvent | null; reasons: string[] } {
  const events: CalendarEvent[] = [];
  const reasons: string[] = [];
  for (const part of message.calendarParts ?? []) {
    try {
      const lines = part.content.split(/\r?\n/);
      if (part.content.length > 100_000 || lines.length > 4000) throw new Error();
      let depth = 0;
      for (const line of lines) {
        if (/^BEGIN:/i.test(line) && ++depth > 20) throw new Error();
        if (/^END:/i.test(line) && --depth < 0) throw new Error();
      }
      if (depth !== 0) throw new Error();
      const root = ICAL.Component.fromString(part.content);
      if (root.name !== "vcalendar" || root.getAllProperties("method").length !== 1) throw new Error();
      const method = String(root.getFirstPropertyValue("method")).toUpperCase();
      if (!part.method || method !== part.method || !["REQUEST", "CANCEL"].includes(method)) throw new Error();
      const components = root.getAllSubcomponents("vevent");
      if (components.length !== 1) throw new Error();
      const event = components[0]!;
      const summary = String(event.getFirstPropertyValue("summary") ?? "");
      if (!/\b(?:interview|phone screen|technical screen|onsite)\b/i.test(summary)) continue;
      for (const name of ["uid", "sequence", "dtstart", "status", "summary", "organizer"])
        if (event.getAllProperties(name).length > 1) throw new Error();
      const uid = event.getFirstPropertyValue("uid");
      const sequence = Number(event.getFirstPropertyValue("sequence") ?? 0);
      if (typeof uid !== "string" || !uid || uid.length > 512 || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error();
      if (event.hasProperty("rrule") || event.hasProperty("recurrence-id")) throw new Error();
      const status = String(event.getFirstPropertyValue("status") ?? "").toUpperCase();
      const time = event.getFirstPropertyValue("dtstart");
      const timezone = event.getFirstProperty("dtstart")?.getParameter("tzid");
      if (time instanceof ICAL.Time && (time.month < 1 || time.month > 12 || time.day < 1 ||
          time.day > new Date(Date.UTC(time.year, time.month, 0)).getUTCDate() ||
          time.hour < 0 || time.hour > 23 || time.minute < 0 || time.minute > 59 || time.second < 0 || time.second > 59)) throw new Error();
      const absolute = time instanceof ICAL.Time && !time.isDate &&
        (timezone == null ? time.zone === ICAL.Timezone.utcTimezone :
          typeof timezone === "string" && time.zone !== ICAL.Timezone.utcTimezone && !!root.getTimeZoneByID(timezone));
      const scheduledFor = absolute ? new Date(time.toUnixTime() * 1000).toISOString() : null;
      const organizer = String(event.getFirstPropertyValue("organizer") ?? "").replace(/^mailto:/i, "");
      const organizerDomain = /^[^\s<>@]+@([A-Za-z0-9.-]+)$/.exec(organizer)?.[1]?.toLowerCase() ?? null;
      if (method === "CANCEL" || status === "CANCELLED") reasons.push("interview-cancelled");
      else if (!scheduledFor || !["", "CONFIRMED"].includes(status)) reasons.push("uncertain-calendar");
      events.push({
        facts: { uidKey: createHash("sha256").update(uid).digest("hex"), sequence, method, status, scheduledFor, organizerDomain },
        summary,
        description: String(event.getFirstPropertyValue("description") ?? ""),
        organizer,
      });
    } catch { reasons.push("uncertain-calendar"); }
  }
  const unique = new Map(events.map(event => [JSON.stringify(event.facts), event]));
  if (unique.size > 1) reasons.push("uncertain-calendar");
  return { event: unique.size === 1 ? [...unique.values()][0]! : null, reasons: [...new Set(reasons)] };
}
