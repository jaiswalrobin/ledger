import {
  ArrowLeft,
  ArrowUpRight,
  CalendarCheck,
  CheckCircle2,
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
import { date, daysSince, fullDate, label, plural, relative } from "../lib.ts";

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
  saveDate,
  saveStatus,
}: {
  detail: OpeningDetail;
  busy: boolean;
  back: () => void;
  setEvent: (eventId: string, state: "ACCEPTED" | "REJECTED") => void;
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
          <a className="secondary" href={detail.canonicalUrl} target="_blank" rel="noopener noreferrer">
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
          const accepted = attempt.events.filter((e) => e.reviewState === "ACCEPTED").length;
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
                    {age !== null && (age === 0 ? " · today" : ` · ${plural(age, "day")} ago`)}
                    {" · "}
                    {attempt.coverageLabel}
                  </p>
                </div>
                <div className="status-pair">
                  <Pill value={attempt.stage} />
                  <Pill value={attempt.outcome} />
                </div>
              </div>
              <StageTrack attempt={attempt} />
              <p className="activity">{attempt.activity}</p>
              {attempt.submissionDateCorrections.map((correction, i) => (
                <p className="small muted correction-note" key={i}>
                  <RotateCcw size={13} aria-hidden /> Submission date corrected from{" "}
                  {date(correction.previousAt)} to {date(correction.correctedAt)} ·{" "}
                  {date(correction.createdAt)}
                </p>
              ))}

              <div className="timeline-head">
                <h3>Timeline</h3>
                <span>{plural(accepted, "accepted update")}</span>
              </div>
              <ol className="timeline">
                {attempt.events.map((event) => {
                  const inactive = event.reviewState !== "ACCEPTED";
                  return (
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
                          <time dateTime={event.occurredAt} title={fullDate(event.occurredAt)}>
                            {date(event.occurredAt)}
                            <span className="rel"> · {relative(event.occurredAt)}</span>
                          </time>
                        </div>
                        <p>
                          {event.origin === "MANUAL"
                            ? "Confirmed by you"
                            : (event.evidence[0]?.subject ?? "Supported by email evidence")}
                        </p>
                        {event.scheduledFor && (
                          <p className={event.currentSchedule ? "activity" : "small muted"}>
                            {event.currentSchedule ? "Current interview time" : "Interview time in this update"}: {fullDate(event.scheduledFor)}
                          </p>
                        )}
                        <small>
                          <span className={`state ${event.reviewState.toLowerCase()}`}>
                            {event.reviewState === "ACCEPTED" ? "Accepted" : label(event.reviewState)}
                          </span>
                          {" · "}
                          {event.evidence[0]?.sourceKind === "GMAIL"
                            ? "Connected Gmail"
                            : event.origin === "MANUAL"
                              ? "Manual correction"
                              : "Selected email import"}
                        </small>
                      </div>
                      <button
                        className={`event-action ${inactive ? "restore" : ""}`}
                        disabled={busy}
                        onClick={() => setEvent(event.id, inactive ? "ACCEPTED" : "REJECTED")}
                      >
                        {inactive ? <Undo2 size={13} aria-hidden /> : <XCircle size={13} aria-hidden />}
                        {inactive ? "Restore" : "Reject update"}
                      </button>
                    </li>
                  );
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
                  save={(stage, outcome) => saveStatus(attempt.id, stage, outcome)}
                />
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
