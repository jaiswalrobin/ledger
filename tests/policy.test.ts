import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  calendarIdentityHolds,
  gateSignal,
  GATED_REASONS,
  judgeCalendarRevision,
  mayApplyAutomatically,
  needsAuthority,
  screenSensitive,
  type AcceptedRevision,
  type AuthorityFacts,
  type GateInput,
  type MatchBasis,
} from "../src/domain/policy.ts";
import type {
  ApplicationEventKind,
  CalendarFacts,
  Sensitivity,
} from "../src/domain/types.ts";

const KINDS = [
  "CONFIRMATION_RECEIVED",
  "ASSESSMENT_INVITED",
  "INTERVIEW_INVITED",
  "INTERVIEW_SCHEDULED",
  "REJECTION_RECEIVED",
  "OFFER_RECEIVED",
] as const satisfies readonly ApplicationEventKind[];
const BASES: readonly (MatchBasis | null)[] = [
  "APPLICATION_ID",
  "SUBMITTED_EMAIL",
  "SOLE_ATTEMPT",
  "CONVERSATION",
  "CALENDAR_IDENTITY",
  null,
];
const BOOLS = [false, true] as const;

describe("screenSensitive", () => {
  it("drops credentials always, access links outside hiring mail, and header-flagged mail", () => {
    const levels: Sensitivity[] = ["NONE", "ACCESS_LINK", "CREDENTIAL"];
    const kept: string[] = [];
    for (const headerSensitive of BOOLS)
      for (const level of levels)
        for (const hiringSignal of BOOLS)
          if (!screenSensitive({ headerSensitive, level, hiringSignal }))
            kept.push(`${level}${hiringSignal ? "+hiring" : ""}`);
    assert.deepEqual(kept, ["NONE", "NONE+hiring", "ACCESS_LINK+hiring"]);
  });
});

describe("gateSignal", () => {
  const signal = (
    over: Partial<GateInput<string>> = {},
  ): GateInput<string> => ({
    kind: "REJECTION_RECEIVED",
    occurredAt: "2026-10-01T10:00:00Z",
    reasons: [],
    fields: {},
    ...over,
  });
  const facts = {
    synced: true,
    recruitingSender: false,
    subject: "Your application",
  };

  it("proceeds with the kind and date when nothing is in doubt", () => {
    assert.deepEqual(gateSignal(signal(), facts), {
      action: "PROCEED",
      kind: "REJECTION_RECEIVED",
      occurredAt: "2026-10-01T10:00:00Z",
    });
  });

  it("maps each gated extractor reason, and the earlier one wins when several apply", () => {
    const codes = [...GATED_REASONS.keys()];
    for (const [i, code] of codes.entries()) {
      assert.deepEqual(gateSignal(signal({ reasons: [code] }), facts), {
        action: "REVIEW",
        reason: GATED_REASONS.get(code),
      });
      for (const later of codes.slice(i + 1))
        assert.deepEqual(
          gateSignal(signal({ reasons: [later, code] }), facts),
          {
            action: "REVIEW",
            reason: GATED_REASONS.get(code),
          },
        );
    }
  });

  it("ignores reasons that are explanations rather than doubts", () => {
    assert.equal(
      gateSignal(
        signal({ reasons: ["phrase:REJECTION_RECEIVED", "mixed-kind"] }),
        facts,
      ).action,
      "PROCEED",
    );
  });

  it("dismisses unrecognised synced mail unless a hiring platform sent something other than an alert", () => {
    const outcomes: string[] = [];
    for (const synced of BOOLS)
      for (const recruitingSender of BOOLS)
        for (const subject of ["Your application", "New jobs for you"]) {
          const gate = gateSignal(signal({ kind: null }), {
            synced,
            recruitingSender,
            subject,
          });
          outcomes.push(gate.action === "REVIEW" ? gate.reason : gate.action);
        }
    assert.deepEqual(outcomes, [
      // Forwarded on purpose: never silently dropped.
      "UNRECOGNIZED",
      "UNRECOGNIZED",
      "UNRECOGNIZED",
      "UNRECOGNIZED",
      // Synced from an ordinary sender, then from a hiring platform.
      "DISMISS",
      "DISMISS",
      "UNRECOGNIZED",
      "DISMISS",
    ]);
  });

  it("checks the kind, then the date, then field conflicts", () => {
    const ambiguous = {
      fieldDecisions: {
        company: { state: "AMBIGUOUS" },
        title: { state: "SUPPORTED" },
      },
    };
    assert.deepEqual(gateSignal(signal({ fields: ambiguous }), facts), {
      action: "REVIEW",
      reason: "CONFLICTING_FIELDS",
    });
    assert.deepEqual(
      gateSignal(signal({ fields: ambiguous, occurredAt: null }), facts),
      {
        action: "REVIEW",
        reason: "NO_DATE",
      },
    );
    assert.deepEqual(
      gateSignal(signal({ fields: ambiguous, occurredAt: null, kind: null }), {
        ...facts,
        synced: false,
      }),
      {
        action: "REVIEW",
        reason: "UNRECOGNIZED",
      },
    );
    assert.deepEqual(
      gateSignal(
        signal({ fields: ambiguous, reasons: ["not-submitted"] }),
        facts,
      ),
      {
        action: "REVIEW",
        reason: "NOT_SUBMITTED",
      },
    );
    const missing = {
      fieldDecisions: {
        company: { state: "MISSING" },
        title: { state: "SUPPORTED" },
      },
    };
    assert.equal(
      gateSignal(signal({ fields: missing }), facts).action,
      "PROCEED",
    );
  });
});

describe("mayApplyAutomatically", () => {
  /** The specification, one row per basis: what else the basis needs to identify the attempt. */
  const STRONG_ATTEMPT: Record<string, (f: AuthorityFacts) => boolean> = {
    APPLICATION_ID: () => true,
    SUBMITTED_EMAIL: (f) => f.strongOpening,
    SOLE_ATTEMPT: (f) => f.confirmedInSameMailbox,
    CONVERSATION: (f) => f.confirmedInSameMailbox,
    CALENDAR_IDENTITY: () => false,
    null: () => false,
  };

  const everyFact = function* (): Generator<AuthorityFacts> {
    for (const basis of BASES)
      for (const strongOpening of BOOLS)
        for (const confirmedInSameMailbox of BOOLS)
          for (const trustedSender of BOOLS)
            for (const verifiedEmployer of BOOLS)
              for (const confidence of ["HIGH", "LOW"] as const)
                yield {
                  basis,
                  strongOpening,
                  confirmedInSameMailbox,
                  trustedSender,
                  verifiedEmployer,
                  confidence,
                };
  };

  it("applies every non-terminal event once it is matched", () => {
    for (const kind of KINDS.filter((k) => !needsAuthority(k)))
      for (const facts of everyFact())
        assert.equal(
          mayApplyAutomatically(kind, facts),
          true,
          `${kind} ${JSON.stringify(facts)}`,
        );
  });

  it("only rejections and offers need authority", () => {
    assert.deepEqual(KINDS.filter(needsAuthority), [
      "REJECTION_RECEIVED",
      "OFFER_RECEIVED",
    ]);
  });

  it("applies a rejection or offer only for a strong attempt, an accountable sender, and high confidence", () => {
    let allowed = 0;
    for (const kind of KINDS.filter(needsAuthority))
      for (const facts of everyFact()) {
        const expected =
          STRONG_ATTEMPT[String(facts.basis)]!(facts) &&
          (facts.trustedSender || facts.verifiedEmployer) &&
          facts.confidence === "HIGH";
        assert.equal(
          mayApplyAutomatically(kind, facts),
          expected,
          `${kind} ${JSON.stringify(facts)}`,
        );
        if (expected) allowed++;
      }
    // Per kind: ID 4 opening/mailbox combos, email 2, sole 2, conversation 2; times 3 senders.
    assert.equal(allowed, 2 * (4 + 2 + 2 + 2) * 3);
  });
});

describe("calendar policy", () => {
  const facts = (over: Partial<CalendarFacts> = {}): CalendarFacts => ({
    uidKey: "uid",
    sequence: 1,
    method: "REQUEST",
    status: "CONFIRMED",
    scheduledFor: "2026-10-20T15:00:00.000Z",
    organizerDomain: "acme.example",
    ...over,
  });

  it("links by UID only for an authenticated sender with the accepted organizer", () => {
    assert.equal(calendarIdentityHolds(facts(), facts(), true), true);
    assert.equal(calendarIdentityHolds(facts(), facts(), false), false);
    assert.equal(calendarIdentityHolds(facts(), null, true), false);
    assert.equal(
      calendarIdentityHolds(
        facts({ organizerDomain: "other.example" }),
        facts(),
        true,
      ),
      false,
    );
    assert.equal(
      calendarIdentityHolds(
        facts({ organizerDomain: null }),
        facts({ organizerDomain: null }),
        true,
      ),
      false,
    );
  });

  it("judges a revision against the accepted one", () => {
    const accepted: AcceptedRevision = {
      attemptId: "a1",
      calendar: facts(),
      senderDomain: "acme.example",
    };
    const judge = (
      incoming: CalendarFacts,
      over: Partial<AcceptedRevision> = {},
      attempt = "a1",
      sender = "acme.example",
    ) =>
      judgeCalendarRevision(
        incoming,
        { ...accepted, ...over },
        attempt,
        sender,
      );
    assert.equal(
      judgeCalendarRevision(facts(), null, "a1", "acme.example"),
      "NEW",
    );
    assert.equal(
      judge(facts({ sequence: 2, scheduledFor: "2026-10-21T15:00:00.000Z" })),
      "NEW",
    );
    assert.equal(judge(facts()), "REPEAT");
    assert.equal(
      judge(facts({ scheduledFor: "2026-10-21T15:00:00.000Z" })),
      "CHANGED_WITHOUT_SEQUENCE",
    );
    assert.equal(judge(facts({ sequence: 0 })), "OUT_OF_ORDER");
    assert.equal(judge(facts({ sequence: 2 }), {}, "a2"), "OUT_OF_ORDER");
    assert.equal(
      judge(facts({ sequence: 2, organizerDomain: "other.example" })),
      "OTHER_SENDER",
    );
    assert.equal(
      judge(facts({ sequence: 2 }), {}, "a1", "mailer.example"),
      "OTHER_SENDER",
    );
    // An unrecorded sender is not a mismatch; a different organizer outranks ordering.
    assert.equal(
      judge(
        facts({ sequence: 2 }),
        { senderDomain: null },
        "a1",
        "mailer.example",
      ),
      "NEW",
    );
    assert.equal(
      judge(facts({ sequence: 0, organizerDomain: "other.example" }), {}, "a2"),
      "OTHER_SENDER",
    );
  });
});

describe("policy stays in one place", () => {
  it("the pipeline asks the policy module instead of re-deciding", () => {
    const pipeline = readFileSync(
      new URL("../src/server/pipeline.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      pipeline,
      /reasons\.includes\(/,
      "extractor reasons are gated in policy.ts",
    );
    assert.doesNotMatch(
      pipeline,
      /TERMINAL_KINDS|confidence\s*[!=]==/,
      "authority is decided in policy.ts",
    );
    assert.doesNotMatch(
      pipeline,
      /=== "CREDENTIAL"|=== "ACCESS_LINK"/,
      "sensitivity is decided in policy.ts",
    );
  });
});
