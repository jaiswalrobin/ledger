"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  Cloud,
  FileText,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import type {
  OpeningView,
  OpeningDetail,
  ReviewView,
  MailboxView,
} from "../src/server/queries.ts";
import type { BrowserSession } from "../src/server/security/web.ts";
import type { Stage, Outcome } from "../src/domain/types.ts";

type Dashboard = {
  openings: OpeningView[];
  reviews: ReviewView[];
  mailboxes: MailboxView[];
};
type Screen = "applications" | "review" | "connections" | "import" | "settings";
const label = (value: string) =>
  value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (x) => x.toUpperCase());
const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "Unknown";
const localInstant = (value: string | null) => {
  if (!value) return "";
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
const errorText: Record<string, string> = {
  SERVICE_UNAVAILABLE: "Ledger could not connect. Please try again shortly.",
  SIGN_IN_REQUIRED: "Your session expired. Sign in again to continue.",
  ORIGIN_REQUIRED: "Refresh the page and try again.",
  RATE_LIMITED: "Please wait a few minutes before trying again.",
  DEMO_ONLY:
    "Gmail connections are available when you sign in with your own account.",
  NOT_FOUND: "That item could not be found.",
  INVALID_FORM: "Check the form fields and try again.",
  KIND_REQUIRED: "Choose an event type before saving this review.",
  INVALID_INPUT: "Choose a valid event type and date.",
  READ_ONLY_GRANT_REQUIRED: "Grant read-only Gmail access and reconnect.",
  DISCONNECT_FIRST: "Disconnect your mailboxes before deleting your account.",
  EMAIL_TOO_LARGE:
    "The email exceeds the safe import limits. Choose a smaller file.",
  UPLOAD_TOO_LARGE: "Choose up to five .eml files, totaling less than 3 MB.",
  CHOOSE_EMAIL_FILES: "Choose up to five .eml files, totaling less than 3 MB.",
};
const reasonText: Record<string, string> = {
  NO_DATE: "The original message has no reliable date.",
  MISSING_JOB_DETAILS: "We could not identify the employer and role.",
  AMBIGUOUS_OPENING: "More than one job opening could match this message.",
  NO_KNOWN_SUBMISSION: "This update has no matching submission yet.",
  AMBIGUOUS_ATTEMPT:
    "We could not tell which application attempt this update belongs to.",
  POSSIBLE_RESENT_CONFIRMATION:
    "This may be another submission or a repeated confirmation.",
  TERMINAL_NEEDS_REVIEW:
    "This outcome needs stronger evidence before it changes your timeline.",
  UNRECOGNIZED: "This message needs your interpretation.",
  AMBIGUOUS_APPLICATION_ID:
    "This application ID appears on more than one attempt.",
  EVENT_PRECEDES_SUBMISSION: "This event appears to predate the submission.",
  CONFLICTING_EVENTS: "This update conflicts with the accepted timeline.",
  CONFLICTING_ALTERNATIVES:
    "The plain-text and HTML versions disagree. Choose how this update should be interpreted.",
};

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(
    `/api/${path}`,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await res.json();
  if (!res.ok)
    throw new Error(
      errorText[data.error] ??
        "This action could not be completed. Check your selection and try again.",
    );
  return data as T;
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-icon">
        <BookOpen size={20} />
      </span>
      <span>
        ledger<span className="brand-dot">.</span>
      </span>
    </div>
  );
}
function Pill({ value }: { value: string }) {
  return <span className={`pill ${value.toLowerCase()}`}>{label(value)}</span>;
}

export default function Home() {
  const [session, setSession] = useState<BrowserSession | null>(null),
    [ready, setReady] = useState(false),
    [demo, setDemo] = useState(false),
    [google, setGoogle] = useState(false);
  const [data, setData] = useState<Dashboard>({
      openings: [],
      reviews: [],
      mailboxes: [],
    }),
    [screen, setScreen] = useState<Screen>("applications");
  const [detail, setDetail] = useState<OpeningDetail | null>(null),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [mobile, setMobile] = useState(false);
  const [fileResults, setFileResults] = useState<string[]>([]),
    [files, setFiles] = useState<File[]>([]),
    [dedicated, setDedicated] = useState(false),
    [deletion, setDeletion] = useState("");
  const input = useRef<HTMLInputElement>(null);
  async function refresh() {
    setData(await api<Dashboard>("dashboard"));
    if (detail) setDetail(await api<OpeningDetail>(`openings/${detail.id}`));
  }
  async function boot() {
    try {
      const state = await api<{
        session: BrowserSession | null;
        demoEnabled: boolean;
        googleReady: boolean;
      }>("session");
      setDemo(state.demoEnabled);
      setGoogle(state.googleReady);
      setData(
        state.session
          ? await api<Dashboard>("dashboard")
          : { openings: [], reviews: [], mailboxes: [] },
      );
      setSession(state.session);
    } catch (error) {
      setSession(null);
      setData({ openings: [], reviews: [], mailboxes: [] });
      setNotice((error as Error).message);
    } finally {
      setReady(true);
    }
  }
  useEffect(() => {
    void boot();
    if (new URL(window.location.href).searchParams.has("authError"))
      setNotice("Google sign-in could not be completed. Please try again.");
  }, []);
  async function work(fn: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    try {
      await fn();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function navigate(next: Screen) {
    setScreen(next);
    setDetail(null);
    setMobile(false);
    setNotice("");
  }
  const attempts = data.openings.flatMap((o) => o.attempts),
    active = attempts.filter((a) => a.outcome === "PENDING"),
    interviews = attempts.filter(
      (a) => a.stage === "INTERVIEW" && a.outcome === "PENDING",
    );
  const filtered = data.openings.filter(
    (o) =>
      `${o.company} ${o.title}`.toLowerCase().includes(query.toLowerCase()) &&
      (filter === "all" ||
        o.attempts.some((a) =>
          filter === "active"
            ? a.outcome === "PENDING"
            : a.stage === "INTERVIEW" && a.outcome === "PENDING",
        )),
  );
  const nav = [
    { id: "applications", title: "Applications", icon: LayoutDashboard },
    { id: "review", title: "Needs review", icon: Inbox },
    { id: "connections", title: "Connections", icon: Cloud },
    { id: "import", title: "Import emails", icon: Upload },
  ] as const;

  if (!ready)
    return (
      <div className="loading">
        <Brand />
        <span>Opening your ledger…</span>
      </div>
    );
  if (!session)
    return (
      <main className="welcome">
        <header>
          <Brand />
          <span className="welcome-note">
            A little clarity for your next chapter
          </span>
        </header>
        <div className="welcome-grid">
          <section>
            <div className="eyebrow">YOUR JOB SEARCH, WITH PERSPECTIVE</div>
            <h1>
              Every application.
              <br />
              One clear story.
            </h1>
            <p>
              Keep the evidence, follow each attempt, and see where you stand.
              Your job search deserves more than a spreadsheet.
            </p>
            <div className="welcome-actions">
              {demo && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void work(async () => {
                      await api("demo", {});
                      await boot();
                    })
                  }
                >
                  {busy ? "Preparing your workspace…" : "Explore the demo"}
                  <ArrowUpRight size={17} />
                </button>
              )}
              {google ? (
                <a className="secondary" href="/api/oauth/login">
                  Sign in with Google
                </a>
              ) : (
                <span className="muted small">
                  Try the sample workspace. Your own account stays separate.
                </span>
              )}
            </div>
            <div className="welcome-trust">
              <ShieldCheck size={16} />
              Your primary inbox stays yours. Import only the emails you choose.
            </div>
            {notice && (
              <div role="alert" className="notice">
                {notice}
              </div>
            )}
          </section>
          <div className="welcome-preview">
            <div className="preview-top">
              <span className="eyebrow">A MORE THOUGHTFUL JOB SEARCH</span>
              <BookOpen size={22} />
            </div>
            <h2>
              Small steps.
              <br />A bigger picture.
            </h2>
            <div className="preview-line">
              <span className="preview-check">
                <Check size={15} />
              </span>
              <div>
                One opening, independent attempts
                <small>
                  A different outcome never overwrites another attempt.
                </small>
              </div>
            </div>
            <div className="preview-line">
              <span className="preview-check">
                <Check size={15} />
              </span>
              <div>
                A timeline you can explain
                <small>Every update points back to its evidence.</small>
              </div>
            </div>
            <div className="preview-line">
              <span className="preview-check">
                <Check size={15} />
              </span>
              <div>
                Clarity about what is monitored
                <small>Forwarded history is always labeled honestly.</small>
              </div>
            </div>
            <div className="preview-footer">
              Built for the next chapter <span>↗</span>
            </div>
          </div>
        </div>
        <footer>
          LEDGER <span>Quietly organized. Clearly evidenced.</span>
          <span>First version · private preview</span>
        </footer>
      </main>
    );

  return (
    <div className="shell">
      <button
        className="mobile-menu icon-button"
        aria-label="Toggle navigation"
        onClick={() => setMobile(!mobile)}
      >
        <Menu />
      </button>
      <aside className={`sidebar ${mobile ? "show" : ""}`}>
        <Brand />
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav>
          {nav.map((item) => (
            <button
              key={item.id}
              className={screen === item.id ? "selected" : ""}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={18} />
              <span>{item.title}</span>
              {item.id === "review" && data.reviews.length > 0 && (
                <b>{data.reviews.length}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-card">
          <span className="mini-mark">
            <ArrowUpRight size={25} />
          </span>
          <h3>
            Your next chapter
            <br />
            is taking shape.
          </h3>
          <p>One application at a time.</p>
        </div>
        <div className="sidebar-bottom">
          <button onClick={() => navigate("settings")}>
            <Settings size={17} />
            Workspace settings
          </button>
          <div className="profile">
            <span className="avatar">
              {session.isDemo ? "D" : session.email?.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>
                {session.isDemo ? "Demo workspace" : session.email}
                <small>
                  {session.isDemo
                    ? "Your own sample data"
                    : "Private workspace"}
                </small>
              </strong>
            </div>
            <button
              aria-label="Sign out"
              className="icon-button"
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  await api("logout", {});
                  setSession(null);
                  setDetail(null);
                  setData({ openings: [], reviews: [], mailboxes: [] });
                })
              }
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <div className="topbar">
          <span>
            Workspace <ChevronRight size={13} />
            {detail
              ? "Application detail"
              : (nav.find((n) => n.id === screen)?.title ?? "Settings")}
          </span>
          <div>
            {session.isDemo && (
              <span className="demo-tag">SAMPLE WORKSPACE</span>
            )}
            <span className="top-status">
              <i /> {busy ? "Saving…" : "All changes saved"}
            </span>
          </div>
        </div>
        {notice && (
          <div role="alert" className="notice">
            <span>{notice}</span>
            <button
              className="icon-button"
              aria-label="Dismiss notification"
              onClick={() => setNotice("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {detail ? (
          <>
            <button className="back" onClick={() => setDetail(null)}>
              <ArrowLeft size={16} />
              Back to applications
            </button>
            <div className="page-heading">
              <div>
                <div className="eyebrow">{detail.company}</div>
                <h1>{detail.title}</h1>
                <p>
                  {detail.location ?? "Location unknown"} ·{" "}
                  {detail.attempts.length} independent attempt
                  {detail.attempts.length === 1 ? "" : "s"}
                </p>
              </div>
            </div>
            <div className="info-strip">
              <ShieldCheck size={18} />
              <span>
                Listing availability is unknown. An application outcome and an
                open job listing are separate facts.
              </span>
            </div>
            {detail.attempts.map((attempt, index) => (
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
                      Submitted {date(attempt.submittedAt)} ·{" "}
                      {attempt.coverageLabel}
                    </p>
                  </div>
                  <div className="status-pair">
                    <Pill value={attempt.stage} />
                    <Pill value={attempt.outcome} />
                  </div>
                </div>
                <p className="activity">{attempt.activity}</p>
                {attempt.submissionDateCorrections.map((correction, i) => (
                  <p className="small muted" key={i}>
                    Submission date corrected from {date(correction.previousAt)}{" "}
                    to {date(correction.correctedAt)} ·{" "}
                    {date(correction.createdAt)}
                  </p>
                ))}
                <SubmissionDateForm
                  submittedAt={attempt.submittedAt}
                  busy={busy}
                  save={(occurredAt) =>
                    void work(async () => {
                      await api("submission-date", {
                        attemptId: attempt.id,
                        occurredAt,
                      });
                      await refresh();
                    })
                  }
                />
                <div className="timeline">
                  {attempt.events.map((event) => (
                    <div
                      className={`timeline-event ${event.reviewState !== "ACCEPTED" ? "inactive" : ""}`}
                      key={event.id}
                    >
                      <span className="timeline-dot" />
                      <div className="timeline-content">
                        <div className="timeline-title">
                          <strong>{label(event.kind)}</strong>
                          <span>{date(event.occurredAt)}</span>
                        </div>
                        <p>
                          {event.origin === "MANUAL"
                            ? "Confirmed by you"
                            : (event.evidence[0]?.subject ??
                              "Supported by email evidence")}
                        </p>
                        <small>
                          {event.reviewState === "ACCEPTED"
                            ? "Accepted"
                            : label(event.reviewState)}{" "}
                          ·{" "}
                          {event.evidence[0]?.sourceKind === "GMAIL"
                            ? "Connected Gmail"
                            : event.origin === "MANUAL"
                              ? "Manual correction"
                              : "Selected email import"}
                        </small>
                      </div>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          void work(async () => {
                            await api("event", {
                              eventId: event.id,
                              state:
                                event.reviewState === "ACCEPTED"
                                  ? "REJECTED"
                                  : "ACCEPTED",
                            });
                            await refresh();
                          })
                        }
                      >
                        {event.reviewState === "ACCEPTED"
                          ? "Reject update"
                          : "Restore"}
                      </button>
                    </div>
                  ))}
                </div>
                <StatusForm
                  stage={attempt.stage}
                  outcome={attempt.outcome}
                  busy={busy}
                  save={(stage, outcome) =>
                    void work(async () => {
                      await api("status", {
                        attemptId: attempt.id,
                        stage,
                        outcome,
                      });
                      await refresh();
                    })
                  }
                />
              </section>
            ))}
          </>
        ) : screen === "applications" ? (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">A LITTLE CLARITY, EVERY DAY</div>
                <h1>Your next chapter.</h1>
                <p>A thoughtful overview of where your applications stand.</p>
              </div>
              <button className="primary" onClick={() => navigate("import")}>
                <Upload size={16} />
                Import emails
              </button>
            </div>
            <div className="stats">
              <Stat
                name="Application attempts"
                value={attempts.length}
                note={`${data.openings.length} distinct job openings`}
              />
              <Stat
                name="Still in progress"
                value={active.length}
                note="With no terminal outcome"
              />
              <Stat
                name="At interview stage"
                value={interviews.length}
                note="The conversation is moving"
              />
              <Stat
                name="Need a closer look"
                value={data.reviews.length}
                note="Waiting for your review"
                highlight
              />
            </div>
            {data.reviews.length > 0 && (
              <button
                className="review-banner"
                onClick={() => navigate("review")}
              >
                <span className="review-banner-icon">
                  <Inbox size={20} />
                </span>
                <span>
                  <strong>A little context from you goes a long way.</strong>
                  <small>
                    {data.reviews.length} update
                    {data.reviews.length === 1 ? " needs" : "s need"} review
                    before changing an application.
                  </small>
                </span>
                <span className="review-link">
                  Review updates <ArrowUpRight size={16} />
                </span>
              </button>
            )}
            <section className="applications-panel">
              <div className="panel-heading">
                <h2>
                  Application ledger <span>{filtered.length}</span>
                </h2>
                <label className="search">
                  <Search size={16} />
                  <input
                    aria-label="Search applications"
                    placeholder="Search company or role"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              </div>
              <div className="tabs">
                {[
                  { id: "all", name: "All applications" },
                  { id: "active", name: "In progress" },
                  { id: "interview", name: "Interviews" },
                ].map((tab) => (
                  <button
                    className={filter === tab.id ? "active" : ""}
                    key={tab.id}
                    onClick={() => setFilter(tab.id)}
                  >
                    {tab.name}
                  </button>
                ))}
                <span>Recent and older actionable applications</span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>COMPANY & ROLE</th>
                      <th>ATTEMPTS</th>
                      <th>PROGRESS</th>
                      <th>MONITORING</th>
                      <th>LAST ACTIVITY</th>
                      <th>
                        <span className="sr-only">View</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((opening, index) => (
                      <tr
                        key={opening.id}
                        onClick={() =>
                          void work(async () =>
                            setDetail(
                              await api<OpeningDetail>(
                                `openings/${opening.id}`,
                              ),
                            ),
                          )
                        }
                      >
                        <td>
                          <div className="company-cell">
                            <span
                              className={`company-avatar tone-${index % 4}`}
                            >
                              {opening.company.slice(0, 1)}
                            </span>
                            <div>
                              <strong>{opening.company}</strong>
                              <span>{opening.title}</span>
                              <small>
                                {opening.location ?? "Location unknown"}
                              </small>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className="attempt-count">
                            {opening.attempts.length}
                          </span>
                          <span className="small muted">
                            {" "}
                            attempt{opening.attempts.length === 1 ? "" : "s"}
                          </span>
                        </td>
                        <td>
                          <div className="table-statuses">
                            {opening.attempts.map((a) => (
                              <Pill
                                key={a.id}
                                value={
                                  a.outcome === "PENDING" ? a.stage : a.outcome
                                }
                              />
                            ))}
                          </div>
                        </td>
                        <td>
                          <span className="coverage">
                            <i
                              className={
                                opening.attempts.every(
                                  (a) => a.coverage === "CONTINUOUS_HEALTHY",
                                )
                                  ? "green"
                                  : ""
                              }
                            />
                            {opening.attempts.every(
                              (a) => a.coverage === "FORWARD_OR_MANUAL",
                            )
                              ? "Forwarded / manual"
                              : opening.attempts.every(
                                    (a) => a.coverage === "CONTINUOUS_HEALTHY",
                                  )
                                ? "Monitored · healthy"
                                : "Monitoring incomplete"}
                          </span>
                        </td>
                        <td className="small muted">
                          {date(opening.latestActivityAt)}
                        </td>
                        <td>
                          <button
                            className="icon-button"
                            aria-label={`View ${opening.company} application`}
                            disabled={busy}
                          >
                            <ChevronRight size={18} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filtered.length === 0 && (
                <div className="empty">
                  <FileText size={28} />
                  <h3>
                    {query
                      ? "No matching applications"
                      : "Start your application ledger"}
                  </h3>
                  <p>
                    {query
                      ? "Try another company or role."
                      : "Import selected application emails to build your first timeline."}
                  </p>
                  <button
                    className="secondary"
                    onClick={() => navigate("import")}
                  >
                    Import an email
                  </button>
                </div>
              )}
              <div className="table-footer">
                <ShieldCheck size={14} />
                Independent attempts. Evidence-backed updates. Silence is never
                a rejection.
              </div>
            </section>
          </>
        ) : screen === "review" ? (
          <>
            <PageTitle
              eyebrow="HUMAN CONTEXT MATTERS"
              title="A closer look."
              subtitle="Ambiguous updates stay here until you decide what they mean."
            />
            {data.reviews.length === 0 ? (
              <div className="empty">
                <CheckCircle2 size={32} />
                <h2>You’re all caught up.</h2>
                <p>There are no updates waiting for review.</p>
              </div>
            ) : (
              data.reviews.map((review) => (
                <ReviewCard
                  key={review.id}
                  review={review}
                  openings={data.openings}
                  busy={busy}
                  submit={(body) =>
                    void work(async () => {
                      await api("review", body);
                      await refresh();
                    })
                  }
                />
              ))
            )}
          </>
        ) : screen === "import" ? (
          <>
            <PageTitle
              eyebrow="ONLY THE EMAILS YOU CHOOSE"
              title="Bring your history."
              subtitle="Import selected .eml messages and forward-as-attachment files."
            />
            <div className="import-grid">
              <section className="import-card">
                <div
                  className="upload-zone"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    setFiles(Array.from(e.dataTransfer.files));
                  }}
                >
                  <span className="upload-icon">
                    <Upload size={26} />
                  </span>
                  <h2>Drop your email files here</h2>
                  <p>Up to 5 .eml files · 3 MB total</p>
                  <button
                    className="secondary"
                    onClick={() => input.current?.click()}
                  >
                    Choose email files
                  </button>
                  <input
                    ref={input}
                    className="sr-only"
                    type="file"
                    accept=".eml,message/rfc822"
                    multiple
                    aria-label="Email files"
                    onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                  />
                </div>
                {files.length > 0 && (
                  <div className="selected-files">
                    {files.map((file, i) => (
                      <div key={i}>
                        <FileText size={16} />
                        <span>{file.name}</span>
                        <small>{Math.ceil(file.size / 1024)} KB</small>
                      </div>
                    ))}
                    <button
                      className="primary"
                      disabled={
                        busy ||
                        files.length > 5 ||
                        files.reduce((n, f) => n + f.size, 0) > 3 * 1024 * 1024
                      }
                      onClick={() =>
                        void work(async () => {
                          const form = new FormData();
                          files.forEach((f) => form.append("files", f));
                          const res = await fetch("/api/import", {
                            method: "POST",
                            body: form,
                          });
                          const result = await res.json();
                          if (!res.ok)
                            throw new Error(
                              errorText[result.error] ??
                                "Import could not be completed.",
                            );
                          setFileResults(
                            result.results.map((r: { status: string }) =>
                              r.status === "APPLIED"
                                ? "Added to your timeline"
                                : r.status === "REVIEW"
                                  ? "Saved for review"
                                  : r.status.startsWith("DUPLICATE")
                                    ? "Already recorded — no duplicate created"
                                    : r.status === "SKIPPED_SENSITIVE"
                                      ? "Excluded: potentially sensitive message"
                                      : r.status === "ERROR"
                                        ? "The file could not be parsed safely"
                                        : "No application event found",
                            ),
                          );
                          setFiles([]);
                          await refresh();
                        })
                      }
                    >
                      {busy ? "Importing…" : "Import selected emails"}
                      <ArrowUpRight size={16} />
                    </button>
                  </div>
                )}
                {fileResults.length > 0 && (
                  <div className="import-results">
                    <h3>Import results</h3>
                    {fileResults.map((result, i) => (
                      <p key={i}>
                        <CheckCircle2 size={16} />
                        {result}
                      </p>
                    ))}
                    <button
                      className="text-button"
                      onClick={() => navigate("applications")}
                    >
                      View your ledger →
                    </button>
                  </div>
                )}
              </section>
              <aside className="import-help">
                <span className="eyebrow">A THOUGHTFUL IMPORT</span>
                <h2>
                  Your primary inbox
                  <br />
                  stays yours.
                </h2>
                <ol>
                  <li>In Gmail, choose an application email.</li>
                  <li>
                    Download the original .eml, or use “Forward as attachment.”
                  </li>
                  <li>Upload only the messages you want Ledger to track.</li>
                </ol>
                <p>
                  We keep structured application facts and evidence references.
                  Full email bodies are discarded.
                </p>
                <div className="help-note">
                  Unsupported formats and uncertain matches go to review.
                  Imported history is labeled as forwarded / manual.
                </div>
                <a className="text-link" href="/api/sample" download>
                  Download a synthetic sample <ArrowUpRight size={15} />
                </a>
              </aside>
            </div>
          </>
        ) : screen === "connections" ? (
          <>
            <PageTitle
              eyebrow="KNOW WHAT IS MONITORED"
              title="Your connections."
              subtitle="Each dedicated account has its own sync progress and health."
            />
            <div className="info-strip">
              <ShieldCheck size={18} />
              <span>
                Gmail read-only access covers the whole authorized mailbox.
                Connect a dedicated job-search account, and keep your primary
                inbox separate.
              </span>
            </div>
            {data.mailboxes.map((mailbox) => (
              <section className="connection-card" key={mailbox.id}>
                <div>
                  <Cloud size={24} />
                  <h2>{mailbox.address}</h2>
                  <Pill value={mailbox.syncState} />
                </div>
                <p>
                  Last healthy sync: {date(mailbox.lastSuccessAt)} · Backfill:{" "}
                  {mailbox.backfillComplete ? "complete" : "incomplete"}
                </p>
                <p>
                  {mailbox.pendingTasks} pending tasks · {mailbox.failedTasks}{" "}
                  failed tasks
                  {mailbox.lastErrorCode
                    ? ` · ${label(mailbox.lastErrorCode)}`
                    : ""}
                </p>
                <div className="connection-actions">
                  <button
                    className="secondary"
                    disabled={busy || mailbox.syncState === "DISCONNECTED"}
                    onClick={() =>
                      void work(async () => {
                        await api("sync", { mailboxId: mailbox.id });
                        await refresh();
                      })
                    }
                  >
                    <RefreshCw size={15} />
                    Sync now
                  </button>
                  {mailbox.failedTasks > 0 && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void work(async () => {
                          await api("retry-failed", { mailboxId: mailbox.id });
                          await refresh();
                        })
                      }
                    >
                      Retry failed work
                    </button>
                  )}
                  <button
                    className="text-button danger"
                    disabled={busy || mailbox.syncState === "DISCONNECTED"}
                    onClick={() =>
                      void work(async () => {
                        const result = await api<{ revoked: boolean }>(
                          "disconnect",
                          { mailboxId: mailbox.id },
                        );
                        await refresh();
                        if (!result.revoked)
                          setNotice(
                            "Disconnected here. Google could not confirm revocation; remove Ledger’s access in your Google account settings.",
                          );
                      })
                    }
                  >
                    Disconnect
                  </button>
                </div>
              </section>
            ))}
            <section className="connect-new">
              <span className="upload-icon">
                <Cloud size={26} />
              </span>
              <h2>Add a dedicated Gmail account</h2>
              <p>
                {session.isDemo
                  ? "The demo uses synthetic imported messages. Sign in with your own account to connect dedicated Gmail accounts."
                  : "Choose a dedicated account for continuing read-only synchronization."}
              </p>
              {!session.isDemo && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={dedicated}
                    onChange={(e) => setDedicated(e.target.checked)}
                  />
                  I will choose a dedicated job-search account.
                </label>
              )}
              <button
                className="primary"
                disabled={busy || session.isDemo || !google || !dedicated}
                onClick={() =>
                  void work(async () => {
                    const result = await api<{ url: string }>("connect", {
                      dedicated: true,
                    });
                    window.location.assign(result.url);
                  })
                }
              >
                Connect Gmail
                <ArrowUpRight size={16} />
              </button>
            </section>
          </>
        ) : (
          <>
            <PageTitle
              eyebrow="YOUR DATA, YOUR CHOICE"
              title="Workspace settings."
              subtitle="Your application history belongs to you."
            />
            <section className="settings-card">
              <h2>
                {session.isDemo
                  ? "Your demo workspace"
                  : "Your private workspace"}
              </h2>
              <p>
                {session.isDemo
                  ? "This workspace contains synthetic examples and is isolated from every other visitor. Your browser session lasts up to seven days; expired demo history is then deleted."
                  : `Signed in as ${session.email}`}
              </p>
              <p>
                You can reject an incorrect event, restore it, or record a
                manual correction from the application detail view.
              </p>
            </section>
            <section className="settings-card">
              <h2>Delete this workspace</h2>
              <p>
                Disconnect active mailboxes first. Deleting removes this
                workspace’s application history, evidence, reviews, and
                sessions. Type DELETE to confirm.
              </p>
              <label className="field-label">
                Confirmation
                <input
                  value={deletion}
                  onChange={(e) => setDeletion(e.target.value)}
                  placeholder="DELETE"
                  aria-label="Deletion confirmation"
                />
              </label>
              <button
                className="danger-button"
                disabled={busy || deletion !== "DELETE"}
                onClick={() =>
                  void work(async () => {
                    await api("delete-account", { confirm: deletion });
                    setSession(null);
                    setDetail(null);
                    setData({ openings: [], reviews: [], mailboxes: [] });
                  })
                }
              >
                Delete workspace
              </button>
            </section>
          </>
        )}
        <footer className="main-footer">
          <span>
            LEDGER <span className="footer-dot">·</span> A little more clarity.
          </span>
          <span>
            {session.isDemo
              ? "Synthetic examples · no mailbox connected"
              : "Evidence-backed application history"}
          </span>
        </footer>
      </main>
    </div>
  );
}
function PageTitle({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
    </div>
  );
}
function Stat({
  name,
  value,
  note,
  highlight = false,
}: {
  name: string;
  value: number;
  note: string;
  highlight?: boolean;
}) {
  return (
    <div className={`stat ${highlight ? "highlight" : ""}`}>
      <span>{name}</span>
      <strong>{value.toString().padStart(2, "0")}</strong>
      <small>{note}</small>
    </div>
  );
}
function SubmissionDateForm({
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
      <summary>Correct submission date</summary>
      <p>
        The previous date is retained in the correction history. Linked
        submission events keep their email evidence.
      </p>
      <label>
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
    </details>
  );
}
function StatusForm({
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
  return (
    <details className="correction">
      <summary>Record a manual correction</summary>
      <div>
        <label>
          Stage
          <select value={s} onChange={(e) => setS(e.target.value as Stage)}>
            {["UNKNOWN", "APPLIED", "ASSESSMENT", "INTERVIEW"].map((v) => (
              <option key={v} value={v}>
                {label(v)}
              </option>
            ))}
          </select>
        </label>
        <label>
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
          disabled={busy}
          onClick={() => save(s, o)}
        >
          Save correction
        </button>
      </div>
    </details>
  );
}
function ReviewCard({
  review,
  openings,
  busy,
  submit,
}: {
  review: ReviewView;
  openings: OpeningView[];
  busy: boolean;
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
  return (
    <section className="review-card">
      <div className="review-card-heading">
        <span className="review-banner-icon">
          <Inbox size={20} />
        </span>
        <div>
          <span className="eyebrow">
            {review.kind ? label(review.kind) : "UNRECOGNIZED MESSAGE"}
          </span>
          <h2>{review.subject ?? "Selected email update"}</h2>
        </div>
        <span className="small muted">{date(review.originalMessageAt)}</span>
      </div>
      <p>{reasonText[review.reason] ?? "This update needs your review."}</p>
      <div className="review-fields">
        <span>{review.fields.company ?? "Employer unknown"}</span>
        <span>{review.fields.title ?? "Role unknown"}</span>
        <span>
          {review.sourceKind === "GMAIL"
            ? "Connected Gmail"
            : "Selected email import"}
        </span>
      </div>
      <div className="review-actions">
        <label>
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
        <button
          className="primary"
          disabled={busy || !attempt || !kind || !at}
          onClick={() =>
            submit({
              action: "assign",
              reviewId: review.id,
              attemptId: attempt,
              kind,
              occurredAt:
                review.originalMessageAt &&
                at === localInstant(review.originalMessageAt)
                  ? review.originalMessageAt
                  : new Date(at).toISOString(),
            })
          }
        >
          Accept and assign
        </button>
        <button
          className="text-button"
          disabled={busy}
          onClick={() => submit({ action: "dismiss", reviewId: review.id })}
        >
          Dismiss
        </button>
      </div>
      <details className="correction">
        <summary>Create an application from this email</summary>
        <div className="create-review">
          <label>
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
          <label>
            Company
            <input
              value={company}
              disabled={!!openingId}
              onChange={(e) => setCompany(e.target.value)}
              maxLength={80}
            />
          </label>
          <label>
            Role
            <input
              value={title}
              disabled={!!openingId}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
            />
          </label>
          <label>
            Submitted contact, if known
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Unknown"
            />
          </label>
          <label>
            Event type
            <select
              aria-label="Event type"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="">Choose an event type</option>
              {[
                "CONFIRMATION_RECEIVED",
                "ASSESSMENT_INVITED",
                "INTERVIEW_INVITED",
                "INTERVIEW_SCHEDULED",
                "REJECTION_RECEIVED",
                "OFFER_RECEIVED",
              ].map((v) => (
                <option key={v} value={v}>
                  {label(v)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Original event date and time
            <input
              type="datetime-local"
              aria-label="Original event date and time"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </label>
          <button
            className="secondary"
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
                occurredAt:
                  review.originalMessageAt &&
                  at === localInstant(review.originalMessageAt)
                    ? review.originalMessageAt
                    : new Date(at).toISOString(),
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
