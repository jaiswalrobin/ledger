import type { CSSProperties, ReactNode } from "react";
import { BookOpen, Check } from "lucide-react";
import type { AttemptView, OpeningView } from "../../src/server/queries.ts";
import {
  BUCKETS,
  JOURNEY,
  bucketOf,
  hueFor,
  initials,
  label,
  stageRank,
  type Bucket,
} from "../lib.ts";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "compact" : ""}`}>
      <span className="brand-icon" aria-hidden>
        <BookOpen size={compact ? 16 : 19} />
      </span>
      <span>
        ledger<span className="brand-dot">.</span>
      </span>
    </div>
  );
}

export function Pill({ value }: { value: string }) {
  return <span className={`pill ${value.toLowerCase()}`}>{label(value)}</span>;
}

/** A soft, deterministic monogram. Decorative: the name is always printed beside it. */
export function CompanyMark({
  name,
  size = "md",
}: {
  name: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span
      aria-hidden
      className={`company-mark ${size}`}
      style={{ "--hue": hueFor(name) } as CSSProperties}
    >
      {initials(name)}
    </span>
  );
}

export function PageTitle({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow: string;
  title: string;
  subtitle: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action}
    </div>
  );
}

/**
 * The whole search as one proportional bar: where every attempt currently sits. Each segment
 * filters the list, so the overview doubles as navigation.
 */
export function JourneyBar({
  openings,
  active,
  onSelect,
}: {
  openings: OpeningView[];
  active: Bucket | null;
  onSelect: (bucket: Bucket | null) => void;
}) {
  const attempts = openings.flatMap((o) => o.attempts);
  const counts = Object.fromEntries(
    BUCKETS.map((b) => [b.key, 0]),
  ) as Record<Bucket, number>;
  for (const a of attempts) counts[bucketOf(a)] += 1;
  const total = attempts.length || 1;
  return (
    <section className="journey" aria-label="Where your applications stand">
      <div className="journey-bar" aria-hidden>
        {BUCKETS.filter((b) => counts[b.key] > 0).map((b) => (
          <span
            key={b.key}
            className={`seg ${b.key} ${active && active !== b.key ? "dim" : ""}`}
            style={{ flexGrow: counts[b.key] / total }}
          />
        ))}
        {attempts.length === 0 && <span className="seg empty" />}
      </div>
      <div className="journey-legend">
        {BUCKETS.map((b) => (
          <button
            key={b.key}
            type="button"
            className={`legend ${b.key} ${active === b.key ? "on" : ""}`}
            aria-pressed={active === b.key}
            disabled={counts[b.key] === 0 && active !== b.key}
            onClick={() => onSelect(active === b.key ? null : b.key)}
          >
            <i aria-hidden />
            <span className="legend-name">{b.name}</span>
            <strong>{counts[b.key]}</strong>
          </button>
        ))}
      </div>
    </section>
  );
}

/** Applied → Assessment → Interview → Outcome, for one attempt. */
export function StageTrack({ attempt }: { attempt: AttemptView }) {
  const rank = stageRank(attempt.stage);
  const closed = attempt.outcome !== "PENDING";
  const outcomeName =
    attempt.outcome === "OFFERED"
      ? "Offer"
      : attempt.outcome === "REJECTED"
        ? "Not selected"
        : attempt.outcome === "WITHDRAWN"
          ? "Withdrawn"
          : "Outcome";
  return (
    <ol className={`stage-track outcome-${attempt.outcome.toLowerCase()}`}>
      {JOURNEY.map((step, i) => {
        const state =
          rank > i + 1 || (rank === i + 1 && closed)
            ? "done"
            : rank === i + 1
              ? "current"
              : "todo";
        return (
          <li key={step.key} className={state}>
            <span className="dot" aria-hidden>
              {state === "done" && <Check size={11} strokeWidth={3} />}
            </span>
            <span className="name">{step.name}</span>
            {state === "current" && <span className="sr-only">(current)</span>}
          </li>
        );
      })}
      <li className={closed ? "final" : "todo"}>
        <span className="dot" aria-hidden />
        <span className="name">{outcomeName}</span>
      </li>
    </ol>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
