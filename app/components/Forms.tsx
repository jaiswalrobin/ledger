import { useEffect, useState } from "react";
import { CalendarClock, PencilLine, Sparkles } from "lucide-react";
import type { Stage, Outcome } from "../../src/domain/types.ts";
import type { OpeningView, ReviewView } from "../../src/server/queries.ts";
import { CompanyMark } from "./ui.tsx";
import { date, label, localInstant, reasonText, relative } from "../lib.ts";

const EVENT_KINDS = [
  "CONFIRMATION_RECEIVED",
  "ASSESSMENT_INVITED",
  "INTERVIEW_INVITED",
  "INTERVIEW_SCHEDULED",
  "REJECTION_RECEIVED",
  "OFFER_RECEIVED",
];

export function SubmissionDateForm({
  submittedAt,
  busy,
  save,
}: {
  submittedAt: string | null;
  busy: boolean;
  save: (value: string) => void;
}) {
  const [value, setValue] = useState(localInstant(submittedAt));
  useEffect(() => setValue(localInstant(submittedAt)), [submittedAt]);
  return (
    <details className="correction">
      <summary>
        <CalendarClock size={15} aria-hidden />
        Correct submission date
      </summary>
      <div className="correction-body">
        <p>
          The previous date is retained in the correction history. Linked
          submission events keep their email evidence.
        </p>
        <div className="field-row">
          <label className="field">
            Submission date and time
            <input
              aria-label="Submission date and time"
              type="datetime-local"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          <button
            className="secondary"
            disabled={busy || !value || !Number.isFinite(Date.parse(value))}
            onClick={() => save(new Date(value).toISOString())}
          >
            Save submission date
          </button>
        </div>
      </div>
    </details>
  );
}

export function StatusForm({
  stage,
  outcome,
  busy,
  save,
}: {
  stage: Stage;
  outcome: Outcome;
  busy: boolean;
  save: (stage: Stage, outcome: Outcome) => void;
}) {
  const [s, setS] = useState(stage),
    [o, setO] = useState(outcome);
  useEffect(() => {
    setS(stage);
    setO(outcome);
  }, [stage, outcome]);
  const changed = s !== stage || o !== outcome;
  return (
    <details className="correction">
      <summary>
        <PencilLine size={15} aria-hidden />
        Record a manual correction
      </summary>
      <div className="correction-body">
        <p>
          Corrections are added to the timeline. Nothing earlier is deleted,
          so you can always see how this attempt got here.
        </p>
        <div className="field-row">
          <label className="field">
            Stage
            <select value={s} onChange={(e) => setS(e.target.value as Stage)}>
              {["UNKNOWN", "APPLIED", "ASSESSMENT", "INTERVIEW"].map((v) => (
                <option key={v} value={v}>
                  {label(v)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Outcome
            <select value={o} onChange={(e) => setO(e.target.value as Outcome)}>
              {["PENDING", "REJECTED", "OFFERED", "WITHDRAWN"].map((v) => (
                <option key={v} value={v}>
                  {label(v)}
                </option>
              ))}
            </select>
          </label>
          <button
            className="secondary"
            disabled={busy || !changed}
            onClick={() => save(s, o)}
          >
            Save correction
          </button>
        </div>
      </div>
    </details>
  );
}

export function ReviewCard({
  review,
  openings,
  busy,
  position,
  submit,
}: {
  review: ReviewView;
  openings: OpeningView[];
  busy: boolean;
  position: string;
  submit: (body: unknown) => void;
}) {
  const [attempt, setAttempt] = useState(
      review.candidates.length === 1 ? review.candidates[0]!.attemptId : "",
    ),
    [company, setCompany] = useState(review.fields.company ?? ""),
    [title, setTitle] = useState(review.fields.title ?? ""),
    [kind, setKind] = useState<string>(review.kind ?? ""),
    [at, setAt] = useState(localInstant(review.originalMessageAt)),
    [openingId, setOpeningId] = useState(
      review.candidateOpenings.length === 1
        ? review.candidateOpenings[0]!.openingId
        : "",
    ),
    [email, setEmail] = useState(review.fields.applicantEmail ?? "");
  const occurredAt = () =>
    review.originalMessageAt && at === localInstant(review.originalMessageAt)
      ? review.originalMessageAt
      : new Date(at).toISOString();
  const tone = review.kind?.startsWith("REJECTION")
    ? "closed"
    : review.kind?.startsWith("OFFER")
      ? "offer"
      : review.kind?.startsWith("INTERVIEW")
        ? "interview"
        : review.kind?.startsWith("ASSESSMENT")
          ? "assessment"
          : "unknown";
  const missing = [
    !attempt && "an attempt",
    !kind && "an event type",
    !at && "a date",
  ].filter(Boolean);
  return (
    <section className="review-card">
      <div className="review-card-heading">
        <span className={`kind-chip ${tone}`}>
          {review.kind ? label(review.kind) : "Unrecognized message"}
        </span>
        <span className="review-position">{position}</span>
      </div>
      <h2>{review.subject ?? "Selected email update"}</h2>
      <p className="review-meta">
        <time dateTime={review.originalMessageAt ?? undefined} title={date(review.originalMessageAt)}>
          {review.originalMessageAt ? relative(review.originalMessageAt) : "Date unknown"}
        </time>
        <span aria-hidden>·</span>
        {review.sourceKind === "GMAIL" ? "Connected Gmail" : "Selected email import"}
      </p>
      <div className="review-why">
        <Sparkles size={16} aria-hidden />
        <p>{reasonText[review.reason] ?? "This update needs your review."}</p>
      </div>
      <dl className="review-fields">
        <div>
          <dt>Employer</dt>
          <dd>{review.fields.company ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{review.fields.title ?? "Unknown"}</dd>
        </div>
      </dl>

      {review.candidates.length > 0 && (
        <div className="suggestions">
          <span className="suggestions-label">Likely matches</span>
          <div className="suggestion-list">
            {review.candidates.map((c) => (
              <button
                key={c.attemptId}
                type="button"
                className={`suggestion ${attempt === c.attemptId ? "on" : ""}`}
                aria-pressed={attempt === c.attemptId}
                onClick={() => setAttempt(c.attemptId)}
              >
                <CompanyMark name={c.company} size="sm" />
                <span>
                  <strong>{c.openingTitle}</strong>
                  <small>{c.company} · {c.applicantEmailMasked}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="review-actions">
        <label className="field grow">
          Assign to an existing attempt
          <select
            aria-label="Choose application attempt"
            value={attempt}
            onChange={(e) => setAttempt(e.target.value)}
          >
            <option value="">Choose an attempt</option>
            {openings.flatMap((o) =>
              o.attempts.map((a, index) => (
                <option key={a.id} value={a.id}>
                  {o.company} · {o.title} · attempt {index + 1} (
                  {a.applicantEmailMasked})
                </option>
              )),
            )}
          </select>
        </label>
        {!review.kind && (
          <label className="field">
            Event type
            <select aria-label="Assigned event type" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Choose…</option>
              {EVENT_KINDS.map((v) => (
                <option key={v} value={v}>{label(v)}</option>
              ))}
            </select>
          </label>
        )}
        <div className="review-buttons">
          <button
            className="primary"
            disabled={busy || missing.length > 0}
            title={missing.length ? `Choose ${missing.join(" and ")} first` : undefined}
            onClick={() =>
              submit({
                action: "assign",
                reviewId: review.id,
                attemptId: attempt,
                kind,
                occurredAt: occurredAt(),
              })
            }
          >
            Accept and assign
          </button>
          <button
            className="ghost"
            disabled={busy}
            onClick={() => submit({ action: "dismiss", reviewId: review.id })}
          >
            Dismiss
          </button>
        </div>
      </div>
      <details className="correction">
        <summary>Create an application from this email</summary>
        <div className="create-review">
          <label className="field wide">
            Job opening
            <select
              aria-label="Job opening"
              value={openingId}
              onChange={(e) => setOpeningId(e.target.value)}
            >
              <option value="">Create a new opening</option>
              {openings.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.company} · {o.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Company
            <input
              value={company}
              disabled={!!openingId}
              onChange={(e) => setCompany(e.target.value)}
              maxLength={80}
            />
          </label>
          <label className="field">
            Role
            <input
              value={title}
              disabled={!!openingId}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
            />
          </label>
          <label className="field">
            Submitted contact, if known
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Unknown"
            />
          </label>
          <label className="field">
            Event type
            <select
              aria-label="Event type"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="">Choose an event type</option>
              {EVENT_KINDS.map((v) => (
                <option key={v} value={v}>
                  {label(v)}
                </option>
              ))}
            </select>
          </label>
          <label className="field wide">
            Original event date and time
            <input
              type="datetime-local"
              aria-label="Original event date and time"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </label>
          <button
            className="secondary wide"
            disabled={
              busy || (!openingId && (!company || !title)) || !kind || !at
            }
            onClick={() =>
              submit({
                action: "create",
                reviewId: review.id,
                company,
                title,
                openingId: openingId || undefined,
                applicantEmail: email,
                kind,
                occurredAt: occurredAt(),
              })
            }
          >
            Create application
          </button>
        </div>
      </details>
    </section>
  );
}
