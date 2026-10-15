import { useMemo, useRef, useState } from "react";
import {
  ArrowDownUp,
  ArrowUpRight,
  ChevronRight,
  CalendarDays,
  FileText,
  Inbox,
  Search,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import type { BrowserSession } from "../../src/server/security/web.ts";
import type { OpeningView } from "../../src/server/queries.ts";
import { CompanyMark, JourneyBar, Kbd, Pill } from "./ui.tsx";
import {
  bucketOf,
  coverageOf,
  date,
  fullDate,
  greeting,
  plural,
  relative,
  statusOf,
  type Bucket,
} from "../lib.ts";

type Filter = "all" | "active" | "interview";
type Sort = "recent" | "company" | "progress";

export function ApplicationsScreen({
  session,
  openings,
  reviews,
  busy,
  searchRef,
  open,
  goImport,
  goReview,
}: {
  session: BrowserSession;
  openings: OpeningView[];
  reviews: number;
  busy: boolean;
  searchRef: React.RefObject<HTMLInputElement | null>;
  open: (id: string) => void;
  goImport: () => void;
  goReview: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [bucket, setBucket] = useState<Bucket | null>(null);
  const [sort, setSort] = useState<Sort>("recent");
  const local = useRef<HTMLInputElement>(null);
  const input = searchRef ?? local;

  const attempts = openings.flatMap((o) => o.attempts);
  const active = attempts.filter((a) => a.outcome === "PENDING");
  const interviews = active.filter((a) => a.stage === "INTERVIEW");
  const offers = attempts.filter((a) => a.outcome === "OFFERED");
  const upcoming = openings
    .flatMap((o) =>
      o.attempts
        .filter((a) => a.outcome === "PENDING" && a.nextInterviewAt)
        .map((a) => ({ opening: o, attempt: a, time: a.nextInterviewAt! })),
    )
    .sort((a, b) => a.time.localeCompare(b.time))
    .slice(0, 5);

  const matches = (o: OpeningView, f: Filter) =>
    f === "all" ||
    o.attempts.some((a) =>
      f === "active"
        ? a.outcome === "PENDING"
        : a.stage === "INTERVIEW" && a.outcome === "PENDING",
    );

  const filtered = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = openings.filter(
      (o) =>
        words.every((w) =>
          `${o.company} ${o.title} ${o.location ?? ""}`
            .toLowerCase()
            .includes(w),
        ) &&
        matches(o, filter) &&
        (!bucket || o.attempts.some((a) => bucketOf(a) === bucket)),
    );
    const rank = (o: OpeningView) =>
      Math.max(
        ...o.attempts.map((a) =>
          a.outcome === "OFFERED"
            ? 5
            : a.outcome !== "PENDING"
              ? 0
              : (
                  {
                    UNKNOWN: 1,
                    APPLIED: 2,
                    ASSESSMENT: 3,
                    INTERVIEW: 4,
                  } as const
                )[a.stage],
        ),
      );
    return [...list].sort((a, b) =>
      sort === "company"
        ? a.company.localeCompare(b.company)
        : sort === "progress"
          ? rank(b) - rank(a)
          : Date.parse(b.latestActivityAt ?? "0") -
            Date.parse(a.latestActivityAt ?? "0"),
    );
  }, [openings, query, filter, bucket, sort]);

  const name = session.isDemo ? "" : (session.email?.split("@")[0] ?? "");
  const summary: string[] = [];
  if (active.length)
    summary.push(`${plural(active.length, "application")} in motion`);
  if (interviews.length)
    summary.push(`${plural(interviews.length, "interview")} on the horizon`);
  if (offers.length)
    summary.push(`${plural(offers.length, "offer")} to consider`);
  if (reviews) summary.push(`${plural(reviews, "update")} waiting for you`);

  const tabs: { id: Filter; name: string }[] = [
    { id: "all", name: "All" },
    { id: "active", name: "In progress" },
    { id: "interview", name: "Interviews" },
  ];
  const narrowed = query || filter !== "all" || bucket;

  return (
    <>
      <div className="page-heading hero">
        <div>
          <div className="eyebrow">A LITTLE CLARITY, EVERY DAY</div>
          <h1>Your next chapter.</h1>
          <p className="hero-summary">
            {greeting()}
            {name ? `, ${name}` : ""}.{" "}
            {summary.length
              ? `${summary.slice(0, -1).join(", ")}${summary.length > 1 ? " and " : ""}${summary.at(-1)}.`
              : openings.length
                ? "Everything is settled for now."
                : "Import a few application emails to begin."}
          </p>
        </div>
        <button className="primary" onClick={goImport}>
          <Upload size={16} aria-hidden />
          Import emails
        </button>
      </div>

      <div className="stats">
        <Stat
          name="Application attempts"
          value={attempts.length}
          note={`across ${plural(openings.length, "opening")}`}
        />
        <Stat
          name="Still in progress"
          value={active.length}
          note="No outcome yet"
        />
        <Stat
          name="At interview stage"
          value={interviews.length}
          note="The conversation is moving"
          accent="interview"
        />
        <Stat
          name="Need a closer look"
          value={reviews}
          note={reviews ? "Waiting for your review" : "All caught up"}
          accent={reviews ? "attention" : undefined}
        />
      </div>

      {attempts.length > 0 && (
        <JourneyBar openings={openings} active={bucket} onSelect={setBucket} />
      )}

      {reviews > 0 && (
        <button className="review-banner" onClick={goReview}>
          <span className="review-banner-icon">
            <Inbox size={19} aria-hidden />
            <b aria-hidden>{reviews}</b>
          </span>
          <span className="review-banner-text">
            <strong>A little context from you goes a long way.</strong>
            <small>
              {reviews} update{reviews === 1 ? " needs" : "s need"} review
              before changing an application.
            </small>
          </span>
          <span className="review-link">
            Review updates <ArrowUpRight size={16} aria-hidden />
          </span>
        </button>
      )}

      {upcoming.length > 0 && (
        <section
          className="upcoming-interviews"
          aria-label="Upcoming interviews"
        >
          <h2>
            <CalendarDays size={18} aria-hidden /> Upcoming interviews
          </h2>
          <p className="small muted">
            Times from accepted invitations, shown in your local time zone.
          </p>
          <ul>
            {upcoming.map(({ opening, attempt, time }) => (
              <li key={attempt.id}>
                <button onClick={() => open(opening.id)}>
                  <span>
                    <strong>{opening.company}</strong>
                    <small>{opening.title}</small>
                  </span>
                  <time dateTime={time}>{fullDate(time)}</time>
                  <ChevronRight size={16} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="applications-panel">
        <div className="panel-heading">
          <h2>
            Application ledger <span className="count">{filtered.length}</span>
          </h2>
          <label className="search">
            <Search size={16} aria-hidden />
            <input
              ref={input}
              aria-label="Search applications"
              placeholder="Search company, role or place"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  e.currentTarget.blur();
                }
              }}
            />
            {query ? (
              <button
                className="icon-button clear"
                aria-label="Clear search"
                onClick={() => setQuery("")}
              >
                <X size={14} />
              </button>
            ) : (
              <Kbd>/</Kbd>
            )}
          </label>
        </div>
        <div className="toolbar">
          <div className="tabs" role="group" aria-label="Filter applications">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={filter === tab.id ? "active" : ""}
                aria-pressed={filter === tab.id}
                onClick={() => setFilter(tab.id)}
              >
                {tab.name}
                <span className="tab-count" aria-hidden>
                  {openings.filter((o) => matches(o, tab.id)).length}
                </span>
              </button>
            ))}
          </div>
          <label className="sort">
            <ArrowDownUp size={14} aria-hidden />
            <span className="sr-only">Sort applications</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
            >
              <option value="recent">Latest activity</option>
              <option value="progress">Furthest along</option>
              <option value="company">Company A–Z</option>
            </select>
          </label>
        </div>
        {bucket && (
          <div className="active-filter">
            Showing applications at <strong>{bucket}</strong> stage
            <button className="text-button" onClick={() => setBucket(null)}>
              Clear
            </button>
          </div>
        )}

        <div className="ledger-list" role="list">
          <div className="ledger-head" aria-hidden>
            <span>Company & role</span>
            <span>Progress</span>
            <span>Monitoring</span>
            <span>Last activity</span>
            <span />
          </div>
          {filtered.map((opening) => {
            const cov = coverageOf(opening);
            return (
              <div
                role="listitem"
                key={opening.id}
                className="ledger-row"
                onClick={() => !busy && open(opening.id)}
              >
                <div className="company-cell">
                  <CompanyMark name={opening.company} />
                  <div>
                    <strong>{opening.company}</strong>
                    <span>{opening.title}</span>
                    <small>
                      {opening.location ?? "Location unknown"}
                      {opening.attempts.length > 1 && (
                        <em className="attempt-chip">
                          {opening.attempts.length} attempts
                        </em>
                      )}
                    </small>
                  </div>
                </div>
                <div className="table-statuses">
                  {opening.attempts.map((a) => (
                    <Pill key={a.id} value={statusOf(a)} />
                  ))}
                </div>
                <span className={`coverage ${cov.tone}`}>
                  <i aria-hidden />
                  {cov.text}
                </span>
                <span
                  className="last-activity"
                  title={date(opening.latestActivityAt)}
                >
                  {relative(opening.latestActivityAt)}
                </span>
                <button
                  className="row-open"
                  aria-label={`View ${opening.company} application`}
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    open(opening.id);
                  }}
                >
                  <ChevronRight size={18} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
        {filtered.length === 0 && (
          <div className="empty">
            <span className="empty-art" aria-hidden>
              <FileText size={26} />
            </span>
            <h3>
              {narrowed
                ? "No matching applications"
                : "Start your application ledger"}
            </h3>
            <p>
              {narrowed
                ? "Try another company or role, or clear the filters."
                : "Import selected application emails to build your first timeline."}
            </p>
            {narrowed ? (
              <button
                className="secondary"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                  setBucket(null);
                }}
              >
                Clear filters
              </button>
            ) : (
              <button className="secondary" onClick={goImport}>
                Import an email
              </button>
            )}
          </div>
        )}
        <div className="table-footer">
          <ShieldCheck size={14} aria-hidden />
          Independent attempts. Evidence-backed updates. Silence is never a
          rejection.
        </div>
      </section>
    </>
  );
}

function Stat({
  name,
  value,
  note,
  accent,
}: {
  name: string;
  value: number;
  note: string;
  accent?: "interview" | "attention" | undefined;
}) {
  return (
    <div className={`stat ${accent ?? ""}`}>
      <span>{name}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}
