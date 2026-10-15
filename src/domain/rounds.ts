/**
 * Interview rounds. Employers send several emails per step: an invitation, a reminder to pick a
 * time, a confirmation with details, a calendar invite, reschedules, and reminders before the
 * day. These are one round, not one round per email.
 *
 * Rounds are a pure projection of accepted events, like the rest of an attempt's state, so they
 * also group history recorded before rounds existed. The same rules decide, while ingesting,
 * whether a new email starts a round, becomes a new fact in the current one, or is only more
 * evidence for a fact already recorded (placeStep).
 */
import type { ApplicationEventKind } from "./types.ts";

export type RoundKind = "ASSESSMENT" | "INTERVIEW";

/** The parts of an event the round rules read. */
export interface StepEvent {
  id: string;
  kind: ApplicationEventKind;
  occurredAt: string;
  /** Present for calendar invitations: their identity, revision and start time. */
  calendar?: {
    uidKey: string;
    sequence: number;
    scheduledFor: string | null;
  } | null;
  /** The email said it follows an earlier round ("the next round", "positive feedback"). */
  startsRound?: boolean;
}

export interface Meeting {
  eventId: string;
  uidKey: string;
  sequence: number;
  scheduledFor: string | null;
}

export interface Round {
  /** 1-based, in the order the rounds started. */
  number: number;
  kind: RoundKind;
  startedAt: string;
  eventIds: string[];
  /** The latest revision of the round's calendar invitation, if any. */
  meeting: Meeting | null;
  /** How many times the meeting was moved (calendar revisions after the first). */
  reschedules: number;
  invited: boolean;
  scheduled: boolean;
}

const STEP_KINDS: ReadonlySet<ApplicationEventKind> = new Set([
  "ASSESSMENT_INVITED",
  "INTERVIEW_INVITED",
  "INTERVIEW_SCHEDULED",
]);

export const isStep = (kind: ApplicationEventKind): boolean =>
  STEP_KINDS.has(kind);

const roundKind = (kind: ApplicationEventKind): RoundKind =>
  kind === "ASSESSMENT_INVITED" ? "ASSESSMENT" : "INTERVIEW";

/** A meeting counts as held this long after it starts; later emails belong to a new round. */
const MEETING_HELD_AFTER_MS = 3 * 60 * 60 * 1000;
/** An invitation this long after the round was scheduled is for the next round. */
const NEW_INVITATION_AFTER_MS = 24 * 60 * 60 * 1000;

interface Open extends Round {
  uids: Set<string>;
  lastScheduledAt: number | null;
}

/** Whether `event` begins a new round rather than continuing `current`. */
function startsNewRound(
  current: Open | null,
  event: Omit<StepEvent, "id">,
): boolean {
  if (!current) return true;
  if (event.startsRound) return true;
  if (roundKind(event.kind) !== current.kind) return true;
  // A revision of this round's invitation always stays with it.
  if (event.calendar && current.uids.has(event.calendar.uidKey)) return false;
  const at = Date.parse(event.occurredAt);
  const meetingAt = current.meeting?.scheduledFor
    ? Date.parse(current.meeting.scheduledFor)
    : null;
  // After the round's meeting has been held, any further step is the next round.
  if (meetingAt !== null && at > meetingAt + MEETING_HELD_AFTER_MS) return true;
  // Invitations do not follow a scheduled interview of the same round.
  if (
    event.kind === "INTERVIEW_INVITED" &&
    current.lastScheduledAt !== null &&
    at > current.lastScheduledAt + NEW_INVITATION_AFTER_MS
  )
    return true;
  return false;
}

const order = (a: StepEvent, b: StepEvent) =>
  a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id);

function build(events: readonly StepEvent[]): Open[] {
  const rounds: Open[] = [];
  for (const event of events.filter((e) => isStep(e.kind)).sort(order)) {
    const previous = rounds.at(-1) ?? null;
    let current: Open;
    if (previous && !startsNewRound(previous, event)) current = previous;
    else {
      current = {
        number: rounds.length + 1,
        kind: roundKind(event.kind),
        startedAt: event.occurredAt,
        eventIds: [],
        meeting: null,
        reschedules: 0,
        invited: false,
        scheduled: false,
        uids: new Set(),
        lastScheduledAt: null,
      };
      rounds.push(current);
    }
    current.eventIds.push(event.id);
    if (event.kind === "INTERVIEW_SCHEDULED") {
      current.scheduled = true;
      current.lastScheduledAt = Date.parse(event.occurredAt);
    } else current.invited = true;
    if (event.calendar) {
      current.uids.add(event.calendar.uidKey);
      const latest = current.meeting;
      // A higher revision of the invitation, or a replacement invitation, moves the meeting.
      const moves =
        !latest ||
        latest.uidKey !== event.calendar.uidKey ||
        event.calendar.sequence > latest.sequence;
      if (moves) {
        if (latest) current.reschedules += 1;
        current.meeting = { eventId: event.id, ...event.calendar };
      }
    }
  }
  return rounds;
}

/** The attempt's assessment and interview rounds, oldest first. */
export function interviewRounds(events: readonly StepEvent[]): Round[] {
  return build(events).map(
    ({ uids: _uids, lastScheduledAt: _last, ...round }) => round,
  );
}

export type Placement =
  /** Record the email as a new event; `startsRound` is stored with it. */
  | { action: "RECORD"; startsRound: boolean }
  /** The current round already holds this fact: attach the email to that event as evidence. */
  | { action: "ATTACH"; eventId: string };

/**
 * Where a new assessment or interview email belongs among the attempt's accepted events.
 * Calendar invitations are always recorded: each revision carries its own time, and repeats of
 * one revision are matched before this point.
 */
export function placeStep(
  events: readonly StepEvent[],
  candidate: Omit<StepEvent, "id">,
): Placement {
  const steps = events.filter((e) => isStep(e.kind));
  const rounds = build(steps);
  const current = rounds.at(-1) ?? null;
  if (startsNewRound(current, candidate))
    return {
      action: "RECORD",
      startsRound: !!candidate.startsRound && !!current,
    };
  if (candidate.calendar) return { action: "RECORD", startsRound: false };
  const inRound = steps
    .filter((e) => current!.eventIds.includes(e.id))
    .sort(order);
  const same = inRound.find((e) => e.kind === candidate.kind);
  if (same) return { action: "ATTACH", eventId: same.id };
  // A late reminder to pick a time, after the round is already scheduled.
  const scheduled = inRound.find((e) => e.kind === "INTERVIEW_SCHEDULED");
  if (candidate.kind === "INTERVIEW_INVITED" && scheduled)
    return { action: "ATTACH", eventId: scheduled.id };
  return { action: "RECORD", startsRound: false };
}
