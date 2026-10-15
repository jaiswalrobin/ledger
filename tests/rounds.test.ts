import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  interviewRounds,
  placeStep,
  type StepEvent,
} from "../src/domain/rounds.ts";

const at = (day: number, hour = 9) =>
  new Date(Date.UTC(2026, 9, day, hour)).toISOString();
const invite = (uidKey: string, sequence: number, day: number, hour = 9) => ({
  uidKey,
  sequence,
  scheduledFor: at(day, hour),
});

/** The Weave sequence: a first round, then a second with reminders and two reschedules. */
const weave: StepEvent[] = [
  { id: "r1-invite", kind: "INTERVIEW_INVITED", occurredAt: at(1) },
  {
    id: "r1-cal",
    kind: "INTERVIEW_SCHEDULED",
    occurredAt: at(2),
    calendar: invite("r1", 0, 3),
  },
  {
    id: "next",
    kind: "INTERVIEW_INVITED",
    occurredAt: at(7),
    startsRound: true,
  },
  { id: "avail", kind: "INTERVIEW_INVITED", occurredAt: at(8) },
  { id: "details", kind: "INTERVIEW_SCHEDULED", occurredAt: at(9, 8) },
  {
    id: "cal0",
    kind: "INTERVIEW_SCHEDULED",
    occurredAt: at(9, 9),
    calendar: invite("r2", 0, 15),
  },
  { id: "resched", kind: "INTERVIEW_SCHEDULED", occurredAt: at(15, 6) },
  {
    id: "cal1",
    kind: "INTERVIEW_SCHEDULED",
    occurredAt: at(15, 6),
    calendar: invite("r2", 1, 16, 5),
  },
  {
    id: "cal2",
    kind: "INTERVIEW_SCHEDULED",
    occurredAt: at(15, 7),
    calendar: invite("r2", 2, 16, 10),
  },
  { id: "reminder", kind: "INTERVIEW_SCHEDULED", occurredAt: at(15, 8) },
  { id: "applied", kind: "CONFIRMATION_RECEIVED", occurredAt: at(1, 0) },
];

describe("interviewRounds", () => {
  it("groups the Weave emails into two rounds, keeping the latest meeting and its reschedules", () => {
    const rounds = interviewRounds(weave);
    assert.equal(rounds.length, 2);
    assert.deepEqual(rounds[0]!.eventIds, ["r1-invite", "r1-cal"]);
    assert.deepEqual(rounds[1], {
      number: 2,
      kind: "INTERVIEW",
      startedAt: at(7),
      eventIds: [
        "next",
        "avail",
        "details",
        "cal0",
        "cal1",
        "resched",
        "cal2",
        "reminder",
      ],
      meeting: {
        eventId: "cal2",
        uidKey: "r2",
        sequence: 2,
        scheduledFor: at(16, 10),
      },
      reschedules: 2,
      invited: true,
      scheduled: true,
      followsUnseenRound: false,
    });
  });

  it("starts a round after the previous meeting was held, even without next-round wording", () => {
    const rounds = interviewRounds([
      {
        id: "a",
        kind: "INTERVIEW_SCHEDULED",
        occurredAt: at(1),
        calendar: invite("u1", 0, 3),
      },
      { id: "reminder", kind: "INTERVIEW_SCHEDULED", occurredAt: at(3, 7) },
      { id: "b", kind: "INTERVIEW_INVITED", occurredAt: at(6) },
    ]);
    assert.deepEqual(
      rounds.map((r) => r.eventIds),
      [["a", "reminder"], ["b"]],
    );
  });

  it("keeps a replacement invitation sent before the meeting in the same round", () => {
    const rounds = interviewRounds([
      {
        id: "a",
        kind: "INTERVIEW_SCHEDULED",
        occurredAt: at(1),
        calendar: invite("u1", 0, 5),
      },
      {
        id: "b",
        kind: "INTERVIEW_SCHEDULED",
        occurredAt: at(2),
        calendar: invite("u2", 0, 6),
      },
    ]);
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0]!.meeting?.uidKey, "u2");
    assert.equal(rounds[0]!.reschedules, 1);
  });

  it("separates assessments from interviews", () => {
    const rounds = interviewRounds([
      { id: "test", kind: "ASSESSMENT_INVITED", occurredAt: at(1) },
      { id: "test-reminder", kind: "ASSESSMENT_INVITED", occurredAt: at(3) },
      { id: "call", kind: "INTERVIEW_INVITED", occurredAt: at(5) },
    ]);
    assert.deepEqual(
      rounds.map((r) => [r.kind, r.eventIds]),
      [
        ["ASSESSMENT", ["test", "test-reminder"]],
        ["INTERVIEW", ["call"]],
      ],
    );
  });

  it("treats an invitation more than a day after scheduling as the next round", () => {
    const base: StepEvent[] = [
      { id: "inv", kind: "INTERVIEW_INVITED", occurredAt: at(1) },
      { id: "sched", kind: "INTERVIEW_SCHEDULED", occurredAt: at(2) },
    ];
    assert.equal(
      interviewRounds([
        ...base,
        { id: "late", kind: "INTERVIEW_INVITED", occurredAt: at(2, 20) },
      ]).length,
      1,
    );
    assert.equal(
      interviewRounds([
        ...base,
        { id: "late", kind: "INTERVIEW_INVITED", occurredAt: at(4) },
      ]).length,
      2,
    );
  });

  it("ignores events that are not steps, and has no rounds without them", () => {
    assert.deepEqual(
      interviewRounds([
        { id: "c", kind: "CONFIRMATION_RECEIVED", occurredAt: at(1) },
      ]),
      [],
    );
  });
});

describe("placeStep", () => {
  const upTo = (id: string) =>
    weave.slice(
      0,
      weave.findIndex((e) => e.id === id),
    );

  it("attaches reminders and repeat confirmations to the fact the round already holds", () => {
    assert.deepEqual(
      placeStep(upTo("avail"), {
        kind: "INTERVIEW_INVITED",
        occurredAt: at(8),
      }),
      { action: "ATTACH", eventId: "next" },
    );
    assert.deepEqual(
      placeStep(upTo("resched"), {
        kind: "INTERVIEW_SCHEDULED",
        occurredAt: at(15, 6),
      }),
      { action: "ATTACH", eventId: "details" },
    );
    // A late "pick a time" reminder after the round is scheduled joins the invitation.
    assert.deepEqual(
      placeStep(upTo("resched"), {
        kind: "INTERVIEW_INVITED",
        occurredAt: at(10),
      }),
      { action: "ATTACH", eventId: "next" },
    );
    // With no invitation on record, it attaches to the scheduled interview.
    assert.deepEqual(
      placeStep([{ id: "s", kind: "INTERVIEW_SCHEDULED", occurredAt: at(2) }], {
        kind: "INTERVIEW_INVITED",
        occurredAt: at(2, 12),
      }),
      { action: "ATTACH", eventId: "s" },
    );
  });

  it("records a new fact in the round, and every calendar revision", () => {
    assert.deepEqual(
      placeStep(upTo("details"), {
        kind: "INTERVIEW_SCHEDULED",
        occurredAt: at(9, 8),
      }),
      { action: "RECORD", startsRound: false },
    );
    assert.deepEqual(
      placeStep(upTo("cal1"), {
        kind: "INTERVIEW_SCHEDULED",
        occurredAt: at(15, 6),
        calendar: invite("r2", 1, 16, 5),
      }),
      { action: "RECORD", startsRound: false },
    );
  });

  it("records a next-round email as starting a round, also as the very first step", () => {
    assert.deepEqual(
      placeStep(upTo("next"), {
        kind: "INTERVIEW_INVITED",
        occurredAt: at(7),
        startsRound: true,
      }),
      { action: "RECORD", startsRound: true },
    );
    assert.deepEqual(
      placeStep([], {
        kind: "INTERVIEW_INVITED",
        occurredAt: at(7),
        startsRound: true,
      }),
      // Kept: it records a round that never reached Ledger.
      { action: "RECORD", startsRound: true },
    );
  });

  it("records the first step after a held meeting as a new round", () => {
    assert.deepEqual(
      placeStep(upTo("next"), { kind: "INTERVIEW_INVITED", occurredAt: at(7) }),
      { action: "RECORD", startsRound: false },
    );
    assert.equal(
      interviewRounds([
        ...upTo("next"),
        { id: "x", kind: "INTERVIEW_INVITED", occurredAt: at(7) },
      ]).length,
      2,
    );
  });

  it("agrees with the projection: replaying placements rebuilds the same rounds", () => {
    const replayed: StepEvent[] = [];
    for (const event of weave) {
      const placement = placeStep(replayed, event);
      if (placement.action === "RECORD")
        replayed.push({ ...event, startsRound: placement.startsRound });
    }
    // Reminders and repeat confirmations collapse into the facts they repeat.
    assert.deepEqual(
      interviewRounds(replayed).map((r) => r.eventIds),
      [
        ["r1-invite", "r1-cal"],
        ["next", "details", "cal0", "cal1", "cal2"],
      ],
    );
  });
});

describe("review fixes", () => {
  it("counts a revision as a reschedule only when the time changed", () => {
    const [round] = interviewRounds([
      {
        id: "a",
        kind: "INTERVIEW_SCHEDULED",
        occurredAt: at(1),
        calendar: invite("u", 0, 5),
      },
      // A location edit: higher SEQUENCE, same start.
      {
        id: "b",
        kind: "INTERVIEW_SCHEDULED",
        occurredAt: at(2),
        calendar: invite("u", 1, 5),
      },
      {
        id: "c",
        kind: "INTERVIEW_SCHEDULED",
        occurredAt: at(3),
        calendar: invite("u", 2, 6),
      },
    ]);
    assert.equal(round!.reschedules, 1);
    assert.equal(round!.meeting?.eventId, "c");
  });

  it("does not start a round each time a reminder repeats next-round wording", () => {
    const rounds = interviewRounds([
      { id: "r1", kind: "INTERVIEW_SCHEDULED", occurredAt: at(1) },
      {
        id: "next",
        kind: "INTERVIEW_INVITED",
        occurredAt: at(5),
        startsRound: true,
      },
      // "Reminder: submit availability for the next round" before scheduling.
      {
        id: "avail",
        kind: "INTERVIEW_INVITED",
        occurredAt: at(6),
        startsRound: true,
      },
      {
        id: "cal0",
        kind: "INTERVIEW_SCHEDULED",
        occurredAt: at(7),
        startsRound: true,
        calendar: invite("n", 0, 12),
      },
      // A revision of the same invitation, titled "Next round interview".
      {
        id: "cal1",
        kind: "INTERVIEW_SCHEDULED",
        occurredAt: at(8),
        startsRound: true,
        calendar: invite("n", 1, 12, 14),
      },
      // "Your next round interview is tomorrow".
      {
        id: "reminder",
        kind: "INTERVIEW_SCHEDULED",
        occurredAt: at(11),
        startsRound: true,
      },
      // After scheduling, an invitation with next-round wording is the round after.
      {
        id: "final",
        kind: "INTERVIEW_INVITED",
        occurredAt: at(11, 12),
        startsRound: true,
      },
    ]);
    assert.deepEqual(
      rounds.map((r) => r.eventIds),
      [["r1"], ["next", "avail", "cal0", "cal1", "reminder"], ["final"]],
    );
  });

  it("keeps a same-invitation revision in its round even with next-round wording", () => {
    const rounds = interviewRounds([
      {
        id: "a",
        kind: "INTERVIEW_SCHEDULED",
        occurredAt: at(1),
        calendar: invite("u", 0, 5),
      },
      {
        id: "b",
        kind: "INTERVIEW_SCHEDULED",
        occurredAt: at(2),
        startsRound: true,
        calendar: invite("u", 1, 6),
      },
    ]);
    assert.equal(rounds.length, 1);
  });
});

describe("an earlier round that never reached Ledger", () => {
  it("numbers rounds from 2 when the first step on record follows an earlier interview", () => {
    const rounds = interviewRounds([
      {
        id: "next",
        kind: "INTERVIEW_INVITED",
        occurredAt: at(7),
        startsRound: true,
      },
      {
        id: "cal",
        kind: "INTERVIEW_SCHEDULED",
        occurredAt: at(9),
        calendar: invite("u", 0, 15),
      },
      {
        id: "final",
        kind: "INTERVIEW_INVITED",
        occurredAt: at(20),
        startsRound: true,
      },
    ]);
    assert.deepEqual(
      rounds.map((r) => [r.number, r.followsUnseenRound, r.eventIds]),
      [
        [2, true, ["next", "cal"]],
        [3, false, ["final"]],
      ],
    );
  });

  it("numbers from 1 when nothing suggests an earlier round", () => {
    const rounds = interviewRounds([
      { id: "a", kind: "INTERVIEW_INVITED", occurredAt: at(7) },
    ]);
    assert.deepEqual(
      rounds.map((r) => [r.number, r.followsUnseenRound]),
      [[1, false]],
    );
  });
});
