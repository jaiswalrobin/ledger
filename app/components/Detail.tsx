import {
  ArrowLeft,
  ArrowUpRight,
  CalendarCheck,
  CheckCircle2,
  Layers,
  ClipboardList,
  Info,
  Mail,
  MessageSquareText,
  PartyPopper,
  PencilLine,
  RotateCcw,
  Undo2,
  XCircle,
} from "lucide-react";
import type { Stage, Outcome } from "../../src/domain/types.ts";
import type { OpeningDetail } from "../../src/server/queries.ts";
import { CompanyMark, Pill, StageTrack } from "./ui.tsx";
import { StatusForm, SubmissionDateForm } from "./Forms.tsx";
import {
  date,
  daysSince,
  fullDate,
  label,
  plural,
  relative,
  roundOf,
} from "../lib.ts";

type Attempt = OpeningDetail["attempts"][number];

/** "Round 2 · Interview · Fri 16 Oct, 16:00 · rescheduled twice · 8 emails" */
function RoundHeading({ round }: { round: Attempt["rounds"][number] }) {
  return (
    <li className="round-divider">
      <strong>
        Round {round.number} ·{" "}
        {round.kind === "ASSESSMENT" ? "Assessment" : "Interview"}
      </strong>
      <span>
        {round.meetingAt
          ? fullDate(round.meetingAt)
          : round.scheduled
            ? "Scheduled"
            : "Invited"}
        {round.reschedules > 0 &&
          ` · rescheduled ${round.reschedules === 1 ? "once" : `${round.reschedules} times`}`}
        {` · ${plural(round.emails, "email")}`}
        {round.followsUnseenRound &&
          " · follows an earlier round that isn't in your emails"}
      </span>
    </li>
  );
}

/**
 * The label of the round correction for an event, or null where it would change nothing: the
 * owner can mark where a round starts (including one that follows a round never in Ledger), or
 * undo such a mark. A round that starts after a held meeting needs no mark.
 */
function roundToggle(
  attempt: Attempt,
  event: Attempt["events"][number],
  index: number,
): string | null {
  if (event.round === null || event.reviewState !== "ACCEPTED") return null;
  if (event.startsRound) return "Not a new round";
  const first =
    attempt.events.findIndex((e) => e.round === event.round) === index;
  if (!first) return "Starts a new round";
  return event.round === attempt.rounds[0]?.number
    ? "Follows an earlier round"
    : null;
}

const EVENT_ICON: Record<string, React.ReactNode> = {
  SUBMITTED: <Mail size={14} />,
  CONFIRMATION_RECEIVED: <CheckCircle2 size={14} />,
  ASSESSMENT_INVITED: <ClipboardList size={14} />,
  INTERVIEW_INVITED: <MessageSquareText size={14} />,
  INTERVIEW_SCHEDULED: <CalendarCheck size={14} />,
  REJECTION_RECEIVED: <XCircle size={14} />,
  OFFER_RECEIVED: <PartyPopper size={14} />,
  MANUAL_CORRECTION: <PencilLine size={14} />,
};
const eventTone = (kind: string) =>
  kind.startsWith("REJECTION")
    ? "closed"
    : kind.startsWith("OFFER")
      ? "offer"
      : kind.startsWith("INTERVIEW")
        ? "interview"
        : kind.startsWith("ASSESSMENT")
          ? "assessment"
          : kind === "MANUAL_CORRECTION"
            ? "manual"
            : "applied";

export function DetailScreen({
  detail,
  busy,
  back,
  setEvent,
  setRoundStart,
  saveDate,
  saveStatus,
}: {
  detail: OpeningDetail;
  busy: boolean;
  back: () => void;
  setEvent: (eventId: string, state: "ACCEPTED" | "REJECTED") => void;
  setRoundStart: (eventId: string, startsRound: boolean) => void;
  saveDate: (attemptId: string, occurredAt: string) => void;
  saveStatus: (attemptId: string, stage: Stage, outcome: Outcome) => void;
}) {
  return (
    <>
      <button className="back" onClick={back}>
        <ArrowLeft size={16} aria-hidden />
        Back to applications
      </button>
      <div className="detail-hero">
        <CompanyMark name={detail.company} size="lg" />
        <div>
          <div className="eyebrow">{detail.company}</div>
          <h1>{detail.title}</h1>
          <p>
            {detail.location ?? "Location unknown"} · {detail.attempts.length}{" "}
            independent attempt{detail.attempts.length === 1 ? "" : "s"}
          </p>
        </div>
        {detail.canonicalUrl && (
          <a
            className="secondary"
            href={detail.canonicalUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Job posting <ArrowUpRight size={15} aria-hidden />
          </a>
        )}
      </div>
      <div className="info-strip">
        <Info size={17} aria-hidden />
        <span>
          Listing availability is unknown. An application outcome and an open
          job listing are separate facts.
        </span>
      </div>
      <div className="attempts">
        {detail.attempts.map((attempt, index) => {
          const age = daysSince(attempt.submittedAt);
          const accepted = attempt.events.filter(
            (e) => e.reviewState === "ACCEPTED",
          ).length;
          return (
            <section key={attempt.id} className="attempt-card">
              <div className="attempt-heading">
                <div>
                  <span className="eyebrow">ATTEMPT {index + 1}</span>
                  <h2>
                    {attempt.applicantEmailMasked === "unknown"
                      ? "Applicant contact unknown"
                      : attempt.applicantEmailMasked}
                  </h2>
                  <p>
                    Submitted {date(attempt.submittedAt)}
                    {age !== null &&
                      (age === 0 ? " · today" : ` · ${plural(age, "day")} ago`)}
                    {" · "}
                    {attempt.coverageLabel}
                  </p>
                </div>
                <div className="status-pair">
                  <Pill value={attempt.stage} />
                  <Pill value={attempt.outcome} />
                  {roundOf(attempt) && (
                    <em className="attempt-chip">{roundOf(attempt)}</em>
                  )}
                </div>
              </div>
              <StageTrack attempt={attempt} />
              <p className="activity">{attempt.activity}</p>
              {attempt.submissionDateCorrections.map((correction, i) => (
                <p className="small muted correction-note" key={i}>
                  <RotateCcw size={13} aria-hidden /> Submission date corrected
                  from {date(correction.previousAt)} to{" "}
                  {date(correction.correctedAt)} · {date(correction.createdAt)}
                </p>
              ))}

              <div className="timeline-head">
                <h3>Timeline</h3>
                <span>{plural(accepted, "accepted update")}</span>
              </div>
              <ol className="timeline">
                {attempt.events.map((event, i) => {
                  const inactive = event.reviewState !== "ACCEPTED";
                  const round =
                    event.round !== null &&
                    attempt.events.findIndex((e) => e.round === event.round) ===
                      i
                      ? attempt.rounds.find((r) => r.number === event.round)
                      : undefined;
                  return [
                    round && (
                      <RoundHeading
                        key={`round-${round.number}`}
                        round={round}
                      />
                    ),
                    <li
                      className={`timeline-event ${eventTone(event.kind)} ${inactive ? "inactive" : ""}`}
                      key={event.id}
                    >
                      <span className="timeline-dot" aria-hidden>
                        {EVENT_ICON[event.kind] ?? <Mail size={14} />}
                      </span>
                      <div className="timeline-content">
                        <div className="timeline-title">
                          <strong>{label(event.kind)}</strong>
                          <time
                            dateTime={event.occurredAt}
                            title={fullDate(event.occurredAt)}
                          >
                            {date(event.occurredAt)}
                            <span className="rel">
                              {" "}
                              · {relative(event.occurredAt)}
                            </span>
                          </time>
                        </div>
                        <p>
                          {event.origin === "MANUAL"
                            ? "Confirmed by you"
                            : (event.evidence[0]?.subject ??
                              "Supported by email evidence")}
                          {event.evidence.length > 1 && (
                            <span
                              className="small muted"
                              title={event.evidence
                                .map((e) => e.subject ?? "Email")
                                .join("\n")}
                            >
                              {" "}
                              · +
                              {plural(event.evidence.length - 1, "more email")}
                            </span>
                          )}
                        </p>
                        {event.scheduledFor && (
                          <p
                            className={
                              event.currentSchedule ? "activity" : "small muted"
                            }
                          >
                            {event.currentSchedule
                              ? "Current interview time"
                              : "Interview time in this update"}
                            : {fullDate(event.scheduledFor)}
                          </p>
                        )}
                        <small>
                          <span
                            className={`state ${event.reviewState.toLowerCase()}`}
                          >
                            {event.reviewState === "ACCEPTED"
                              ? "Accepted"
                              : label(event.reviewState)}
                          </span>
                          {" · "}
                          {event.evidence[0]?.sourceKind === "GMAIL"
                            ? "Connected Gmail"
                            : event.origin === "MANUAL"
                              ? "Manual correction"
                              : "Selected email import"}
                        </small>
                      </div>
                      <div className="event-actions">
                        <button
                          className={`event-action ${inactive ? "restore" : ""}`}
                          disabled={busy}
                          onClick={() =>
                            setEvent(
                              event.id,
                              inactive ? "ACCEPTED" : "REJECTED",
                            )
                          }
                        >
                          {inactive ? (
                            <Undo2 size={13} aria-hidden />
                          ) : (
                            <XCircle size={13} aria-hidden />
                          )}
                          {inactive ? "Restore" : "Reject update"}
                        </button>
                        {roundToggle(attempt, event, i) && (
                          <button
                            className="event-action"
                            disabled={busy}
                            onClick={() =>
                              setRoundStart(event.id, !event.startsRound)
                            }
                          >
                            <Layers size={13} aria-hidden />
                            {roundToggle(attempt, event, i)}
                          </button>
                        )}
                      </div>
                    </li>,
                  ];
                })}
              </ol>
              <div className="attempt-tools">
                <SubmissionDateForm
                  submittedAt={attempt.submittedAt}
                  busy={busy}
                  save={(occurredAt) => saveDate(attempt.id, occurredAt)}
                />
                <StatusForm
                  stage={attempt.stage}
                  outcome={attempt.outcome}
                  busy={busy}
                  save={(stage, outcome) =>
                    saveStatus(attempt.id, stage, outcome)
                  }
                />
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
