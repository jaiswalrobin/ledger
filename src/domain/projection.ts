import type {
  ApplicationEvent,
  AttemptProjection,
  Outcome,
  Stage,
} from "./types.ts";

const RANK: Record<Stage, number> = {
  UNKNOWN: 0,
  APPLIED: 1,
  ASSESSMENT: 2,
  INTERVIEW: 3,
};

function promoted(stage: Stage, next: Stage): Stage {
  return RANK[next] > RANK[stage] ? next : stage;
}

function terminalFromEvent(kind: ApplicationEvent["kind"]): Outcome | null {
  switch (kind) {
    case "REJECTION_RECEIVED":
      return "REJECTED";
    case "OFFER_RECEIVED":
      return "OFFERED";
    case "WITHDRAWN":
      return "WITHDRAWN";
    default:
      return null;
  }
}

/**
 * Pure, deterministic projection. Only validated ACCEPTED events affect state.
 * Conflicting post-terminal signals do not silently overwrite a terminal outcome.
 */
export function projectAttempt(
  attemptId: string,
  events: readonly ApplicationEvent[],
): AttemptProjection {
  let stage: Stage = "UNKNOWN";
  let outcome: Outcome = "PENDING";
  let lastActivityAt: string | null = null;
  let latestActivityMillis = Number.NEGATIVE_INFINITY;
  const conflicts: string[] = [];

  const accepted = events
    .filter((e) => e.attemptId === attemptId && e.reviewState === "ACCEPTED")
    .sort(
      (a, b) =>
        a.occurredAt.localeCompare(b.occurredAt) ||
        a.observedAt.localeCompare(b.observedAt) ||
        a.id.localeCompare(b.id),
    );

  for (const event of accepted) {
    const eventMillis = Date.parse(event.occurredAt);
    if (!Number.isFinite(eventMillis)) {
      conflicts.push("Invalid event timestamp: " + event.id);
      continue;
    }
    if (eventMillis > latestActivityMillis) {
      latestActivityMillis = eventMillis;
      lastActivityAt = event.occurredAt;
    }

    if (event.kind === "MANUAL_CORRECTION") {
      if (!event.correction) {
        conflicts.push("Missing manual correction payload: " + event.id);
        continue;
      }
      stage = event.correction.stage;
      outcome = event.correction.outcome;
      continue;
    }

    const terminal = terminalFromEvent(event.kind);
    if (terminal) {
      if (outcome !== "PENDING" && outcome !== terminal) {
        conflicts.push("Conflicting terminal event: " + event.id);
        continue;
      }
      outcome = terminal;
      continue;
    }
    if (outcome !== "PENDING") {
      // A response after a rejection/offer is possible, but requires adjudication.
      if (event.kind !== "CONFIRMATION_RECEIVED")
        conflicts.push("Non-terminal event after outcome: " + event.id);
      continue;
    }
    switch (event.kind) {
      case "SUBMITTED":
      case "CONFIRMATION_RECEIVED":
        stage = promoted(stage, "APPLIED");
        break;
      case "ASSESSMENT_INVITED":
        stage = promoted(stage, "ASSESSMENT");
        break;
      case "INTERVIEW_INVITED":
      case "INTERVIEW_SCHEDULED":
        stage = promoted(stage, "INTERVIEW");
        break;
    }
  }
  return { stage, outcome, lastActivityAt, conflicts };
}
