import { useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Cloud,
  Copy,
  FileText,
  Inbox,
  Info,
  Monitor,
  Moon,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Sun,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { BrowserSession } from "../../src/server/security/web.ts";
import type {
  MailboxView,
  OpeningView,
  ReviewView,
} from "../../src/server/queries.ts";
import { PageTitle, Pill } from "./ui.tsx";
import { ReviewCard } from "./Forms.tsx";
import { date, errorText, label, relative } from "../lib.ts";

export type Theme = "system" | "light" | "dark";

// ---- review -----------------------------------------------------------------------------

export function ReviewScreen({
  reviews,
  openings,
  busy,
  submit,
  goApplications,
}: {
  reviews: ReviewView[];
  openings: OpeningView[];
  busy: boolean;
  submit: (body: unknown) => void;
  goApplications: () => void;
}) {
  return (
    <>
      <PageTitle
        eyebrow="HUMAN CONTEXT MATTERS"
        title="A closer look."
        subtitle="Ambiguous updates stay here until you decide what they mean. Nothing changes your timeline without you."
      />
      {reviews.length === 0 ? (
        <div className="empty celebrate">
          <span className="empty-art" aria-hidden>
            <CheckCircle2 size={28} />
          </span>
          <h2>You’re all caught up.</h2>
          <p>There are no updates waiting for review.</p>
          <button className="secondary" onClick={goApplications}>
            Back to your ledger
          </button>
        </div>
      ) : (
        <div className="review-stack">
          {reviews.map((review, i) => (
            <ReviewCard
              key={review.id}
              review={review}
              openings={openings}
              busy={busy}
              position={`${i + 1} of ${reviews.length}`}
              submit={submit}
            />
          ))}
        </div>
      )}
    </>
  );
}

// ---- import -----------------------------------------------------------------------------

const LIMIT_BYTES = 3 * 1024 * 1024;
const LIMIT_FILES = 5;

type ResultTone = "ok" | "review" | "same" | "skip" | "error";
const RESULT: Record<string, { text: string; tone: ResultTone }> = {
  APPLIED: { text: "Added to your timeline", tone: "ok" },
  REVIEW: { text: "Saved for review", tone: "review" },
  DUPLICATE: { text: "Already recorded — no duplicate created", tone: "same" },
  SKIPPED_SENSITIVE: { text: "Excluded: potentially sensitive message", tone: "skip" },
  ERROR: { text: "The file could not be parsed safely", tone: "error" },
};
const resultOf = (status: string) =>
  RESULT[status] ??
  (status.startsWith("DUPLICATE")
    ? RESULT.DUPLICATE!
    : { text: "No application event found", tone: "skip" as const });

export function ImportScreen({
  busy,
  work,
  refresh,
  goApplications,
  goReview,
}: {
  busy: boolean;
  work: (fn: () => Promise<void>) => void;
  refresh: () => Promise<void>;
  goApplications: () => void;
  goReview: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<{ text: string; tone: ResultTone }[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const total = files.reduce((n, f) => n + f.size, 0);
  const tooMany = files.length > LIMIT_FILES;
  const tooBig = total > LIMIT_BYTES;
  const odd = files.filter((f) => !/\.eml$/i.test(f.name) && f.type !== "message/rfc822");
  const add = (list: FileList | null) => {
    if (!list) return;
    setResults([]);
    // Adding more files appends; picking the same file twice does not duplicate it.
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...Array.from(list).filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
  };
  const counts = results.reduce<Record<ResultTone, number>>(
    (acc, r) => ({ ...acc, [r.tone]: acc[r.tone] + 1 }),
    { ok: 0, review: 0, same: 0, skip: 0, error: 0 },
  );

  return (
    <>
      <PageTitle
        eyebrow="ONLY THE EMAILS YOU CHOOSE"
        title="Bring your history."
        subtitle="Import selected .eml messages and forward-as-attachment files."
      />
      <div className="import-grid">
        <section className="import-card">
          <div
            className={`upload-zone ${dragging ? "dragging" : ""}`}
            onDragEnter={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              add(e.dataTransfer.files);
            }}
          >
            <span className="upload-icon" aria-hidden>
              <Upload size={24} />
            </span>
            <h2>{dragging ? "Release to add these emails" : "Drop your email files here"}</h2>
            <p>Up to {LIMIT_FILES} .eml files · 3 MB total</p>
            <button className="secondary" onClick={() => input.current?.click()}>
              Choose email files
            </button>
            <input
              ref={input}
              className="sr-only"
              type="file"
              accept=".eml,message/rfc822"
              multiple
              aria-label="Email files"
              onChange={(e) => {
                add(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          {files.length > 0 && (
            <div className="selected-files">
              <div className="capacity" aria-label="Upload limits">
                <div className="capacity-bar">
                  <span
                    className={tooBig ? "over" : ""}
                    style={{ width: `${Math.min(100, (total / LIMIT_BYTES) * 100)}%` }}
                  />
                </div>
                <small className={tooBig || tooMany ? "warn" : ""}>
                  {files.length} of {LIMIT_FILES} files · {(total / 1024 / 1024).toFixed(2)} of 3 MB
                </small>
              </div>
              <ul>
                {files.map((file, i) => (
                  <li key={`${file.name}-${i}`} className={odd.includes(file) ? "odd" : ""}>
                    <FileText size={16} aria-hidden />
                    <span className="file-name">{file.name}</span>
                    <small>{Math.ceil(file.size / 1024)} KB</small>
                    <button
                      className="icon-button"
                      aria-label={`Remove ${file.name}`}
                      onClick={() => setFiles(files.filter((_, j) => j !== i))}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
              {odd.length > 0 && (
                <p className="file-warning">
                  <AlertTriangle size={14} aria-hidden /> Files that are not .eml will
                  likely be rejected by the parser.
                </p>
              )}
              <button
                className="primary"
                disabled={busy || tooMany || tooBig}
                onClick={() =>
                  work(async () => {
                    const form = new FormData();
                    files.forEach((f) => form.append("files", f));
                    const res = await fetch("/api/import", { method: "POST", body: form });
                    const result = await res.json();
                    if (!res.ok)
                      throw new Error(errorText[result.error] ?? "Import could not be completed.");
                    setResults(result.results.map((r: { status: string }) => resultOf(r.status)));
                    setFiles([]);
                    await refresh();
                  })
                }
              >
                {busy ? "Importing…" : "Import selected emails"}
                <ArrowUpRight size={16} aria-hidden />
              </button>
            </div>
          )}

          {results.length > 0 && (
            <div className="import-results" aria-live="polite">
              <h3>Import results</h3>
              <div className="result-summary">
                {counts.ok > 0 && <span className="ok">{counts.ok} added</span>}
                {counts.review > 0 && <span className="review">{counts.review} for review</span>}
                {counts.same > 0 && <span className="same">{counts.same} already known</span>}
                {counts.skip + counts.error > 0 && <span className="skip">{counts.skip + counts.error} not used</span>}
              </div>
              <ul>
                {results.map((r, i) => (
                  <li key={i} className={r.tone}>
                    {r.tone === "ok" ? <CheckCircle2 size={16} aria-hidden /> : r.tone === "review" ? <Inbox size={16} aria-hidden /> : r.tone === "same" ? <Copy size={16} aria-hidden /> : r.tone === "error" ? <AlertTriangle size={16} aria-hidden /> : <ShieldOff size={16} aria-hidden />}
                    <span>{r.text}</span>
                  </li>
                ))}
              </ul>
              <div className="result-actions">
                <button className="text-button" onClick={goApplications}>
                  View your ledger →
                </button>
                {counts.review > 0 && (
                  <button className="text-button" onClick={goReview}>
                    Open review queue →
                  </button>
                )}
              </div>
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
          <ol className="steps">
            <li>
              <b>1</b>
              <span>In Gmail, open an application email.</span>
            </li>
            <li>
              <b>2</b>
              <span>Choose <em>⋮ → Download message</em>, or “Forward as attachment.”</span>
            </li>
            <li>
              <b>3</b>
              <span>Upload only the messages you want Ledger to track.</span>
            </li>
          </ol>
          <p>
            We keep structured application facts and evidence references. Full
            email bodies are discarded.
          </p>
          <div className="help-note">
            Unsupported formats and uncertain matches go to review. Imported
            history is labeled as forwarded / manual.
          </div>
          <a className="text-link" href="/api/sample" download>
            Download a synthetic sample <ArrowUpRight size={15} aria-hidden />
          </a>
        </aside>
      </div>
    </>
  );
}

// ---- connections ------------------------------------------------------------------------

const HEALTH: Record<MailboxView["syncState"], { tone: string; text: string }> = {
  HEALTHY: { tone: "green", text: "Healthy" },
  INITIALIZING: { tone: "amber", text: "Initial search running" },
  DEGRADED: { tone: "amber", text: "Needs attention" },
  RESYNC_REQUIRED: { tone: "amber", text: "Catching up" },
  DISCONNECTED: { tone: "quiet", text: "Disconnected" },
};

export function ConnectionsScreen({
  session,
  mailboxes,
  google,
  busy,
  sync,
  recheck,
  retry,
  disconnect,
  connect,
}: {
  session: BrowserSession;
  mailboxes: MailboxView[];
  google: boolean;
  busy: boolean;
  sync: (id: string) => void;
  recheck: (id: string) => void;
  retry: (id: string) => void;
  disconnect: (id: string) => void;
  connect: () => void;
}) {
  const [dedicated, setDedicated] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <>
      <PageTitle
        eyebrow="KNOW WHAT IS MONITORED"
        title="Your connections."
        subtitle="Each dedicated account has its own sync progress and health."
      />
      <div className="info-strip">
        <ShieldCheck size={18} aria-hidden />
        <span>
          Gmail read-only access covers the whole authorized mailbox. Connect a
          dedicated job-search account, and keep your primary inbox separate.
        </span>
      </div>
      {mailboxes.map((mailbox) => {
        const health = HEALTH[mailbox.syncState];
        const s = mailbox.processingSummary;
        const totalSeen = s.processed + s.unrecognized + s.skippedSensitive + s.quarantined + s.skippedOther;
        const bar = [
          { key: "used", n: s.processed, name: "Used" },
          { key: "none", n: s.unrecognized, name: "No event" },
          { key: "private", n: s.skippedSensitive, name: "Privacy" },
          { key: "parse", n: s.quarantined, name: "Unparsed" },
          { key: "other", n: s.skippedOther, name: "Other" },
        ];
        return (
          <section className="connection-card" key={mailbox.id}>
            <div className="connection-head">
              <span className={`connection-icon ${health.tone}`} aria-hidden>
                <Cloud size={20} />
              </span>
              <div>
                <h2>{mailbox.address}</h2>
                <p className={`health ${health.tone}`}>
                  <i aria-hidden /> {health.text}
                  {mailbox.lastSuccessAt && (
                    <span className="muted"> · synced {relative(mailbox.lastSuccessAt)}</span>
                  )}
                </p>
              </div>
              <Pill value={mailbox.syncState} />
            </div>

            <dl className="connection-facts">
              <div>
                <dt>Last healthy sync</dt>
                <dd>{date(mailbox.lastSuccessAt)}</dd>
              </div>
              <div>
                <dt>Backfill</dt>
                <dd>{mailbox.backfillComplete ? "Complete" : "Incomplete"}</dd>
              </div>
              <div>
                <dt>Work queue</dt>
                <dd>
                  {mailbox.pendingTasks} pending tasks · {mailbox.failedTasks} failed tasks
                  {mailbox.lastErrorCode ? ` · ${label(mailbox.lastErrorCode)}` : ""}
                </dd>
              </div>
            </dl>
            <p className="connection-scope">
              Initial search: {date(mailbox.backfillStart)} to {date(mailbox.backfillEnd)}.{" "}
              Searches recruiting subjects and known hiring platforms. A completed sync does not guarantee every application was recognized.
            </p>

            {totalSeen > 0 && (
              <div className="mail-bar" aria-hidden>
                {bar.filter((b) => b.n > 0).map((b) => (
                  <span key={b.key} className={b.key} style={{ flexGrow: b.n }} title={`${b.name}: ${b.n}`} />
                ))}
              </div>
            )}
            <div className="sync-summary" aria-label="Email processing totals">
              <p>Across all syncs: {s.processed} emails used for timelines or review · {s.unrecognized} with no recognized application event.</p>
              <p>{s.skippedSensitive} excluded by privacy checks · {s.quarantined} could not be safely parsed · {s.skippedOther} other excluded emails.</p>
              {s.partiallyProcessed > 0 && <p>{s.partiallyProcessed} emails had valid originals imported, but some attachments could not be parsed. See recent excluded emails.</p>}
              <p className="muted">These are email counts. Several emails can belong to one application.</p>
            </div>
            {mailbox.excludedMessages.length > 0 && (
              <details className="sync-exclusions">
                <summary>See recent excluded emails</summary>
                <p>Up to 20 recent exclusions. Open the original in your connected Gmail account to inspect it. Ledger does not retain these email bodies.</p>
                <ul>
                  {mailbox.excludedMessages.map((message) => (
                    <li key={message.messageId}>
                      <span>
                        {message.reason === "PRIVACY_CHECK" ? "Excluded by privacy checks"
                          : message.reason === "PARSE_LIMIT" ? "Could not safely parse"
                          : message.reason === "UNCERTAIN_HEADERS" ? "Unclear recruiting subject"
                          : "No recognized application event"}
                        {message.originalMessageAt ? ` · ${date(message.originalMessageAt)}` : ""}
                      </span>
                      <a className="text-link" target="_blank" rel="noopener noreferrer"
                        href={`https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox.address)}#all/${encodeURIComponent(message.messageId)}`}>
                        Open in Gmail
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="connection-actions">
              <button className="secondary" disabled={busy || mailbox.syncState === "DISCONNECTED"} onClick={() => sync(mailbox.id)}>
                <RefreshCw size={15} aria-hidden className={busy ? "spin" : ""} />
                Sync now
              </button>
              <button
                className="secondary"
                disabled={busy || mailbox.syncState === "DISCONNECTED" || mailbox.recheckInProgress}
                onClick={() => recheck(mailbox.id)}
              >
                Recheck last 60 days
              </button>
              {mailbox.failedTasks > 0 && (
                <button className="secondary" disabled={busy} onClick={() => retry(mailbox.id)}>
                  Retry failed work
                </button>
              )}
              {confirming === mailbox.id ? (
                <span className="confirm-inline">
                  Stop syncing this account?
                  <button
                    className="danger-button small"
                    disabled={busy}
                    onClick={() => {
                      setConfirming(null);
                      disconnect(mailbox.id);
                    }}
                  >
                    Disconnect
                  </button>
                  <button className="ghost" onClick={() => setConfirming(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  className="text-button danger"
                  disabled={busy || mailbox.syncState === "DISCONNECTED"}
                  onClick={() => setConfirming(mailbox.id)}
                >
                  Disconnect
                </button>
              )}
            </div>
            <p className="footnote">
              <Info size={13} aria-hidden /> Recheck repeats the recent search and retries skipped emails using the current parser. Privacy checks still apply. Use Import emails for older history.
            </p>
          </section>
        );
      })}
      <section className="connect-new">
        <span className="upload-icon" aria-hidden>
          <Cloud size={24} />
        </span>
        <h2>Add a dedicated Gmail account</h2>
        <p>
          {session.isDemo
            ? "The demo uses synthetic imported messages. Sign in with your own account to connect dedicated Gmail accounts."
            : "Choose a dedicated account for continuing read-only synchronization."}
        </p>
        {!session.isDemo && (
          <label className="checkbox">
            <input type="checkbox" checked={dedicated} onChange={(e) => setDedicated(e.target.checked)} />
            I will choose a dedicated job-search account.
          </label>
        )}
        <button className="primary" disabled={busy || session.isDemo || !google || !dedicated} onClick={connect}>
          Connect Gmail
          <ArrowUpRight size={16} aria-hidden />
        </button>
      </section>
    </>
  );
}

// ---- settings ---------------------------------------------------------------------------

export function SettingsScreen({
  session,
  busy,
  theme,
  setTheme,
  remove,
}: {
  session: BrowserSession;
  busy: boolean;
  theme: Theme;
  setTheme: (t: Theme) => void;
  remove: (confirm: string) => void;
}) {
  const [deletion, setDeletion] = useState("");
  return (
    <>
      <PageTitle
        eyebrow="YOUR DATA, YOUR CHOICE"
        title="Workspace settings."
        subtitle="Your application history belongs to you."
      />
      <section className="settings-card">
        <h2>{session.isDemo ? "Your demo workspace" : "Your private workspace"}</h2>
        <p>
          {session.isDemo
            ? "This workspace contains synthetic examples and is isolated from every other visitor. Your browser session lasts up to seven days; expired demo history is then deleted."
            : `Signed in as ${session.email}`}
        </p>
        <p>
          You can reject an incorrect event, restore it, or record a manual
          correction from the application detail view.
        </p>
      </section>
      <section className="settings-card">
        <h2>Appearance</h2>
        <p>Ledger follows your device by default. Choose a fixed look if you prefer.</p>
        <div className="segmented" role="radiogroup" aria-label="Appearance">
          {([
            ["system", "System", <Monitor size={15} key="m" />],
            ["light", "Light", <Sun size={15} key="s" />],
            ["dark", "Dark", <Moon size={15} key="d" />],
          ] as const).map(([value, name, icon]) => (
            <button
              key={value}
              role="radio"
              aria-checked={theme === value}
              className={theme === value ? "on" : ""}
              onClick={() => setTheme(value)}
            >
              {icon}
              {name}
            </button>
          ))}
        </div>
      </section>
      <section className="settings-card">
        <h2>Keyboard shortcuts</h2>
        <dl className="shortcuts">
          <div><dt><kbd className="kbd">⌘</kbd><kbd className="kbd">K</kbd></dt><dd>Open the command menu (Ctrl K on Windows and Linux)</dd></div>
          <div><dt><kbd className="kbd">/</kbd></dt><dd>Search your applications</dd></div>
          <div><dt><kbd className="kbd">Esc</kbd></dt><dd>Close menus, clear search, or go back</dd></div>
        </dl>
      </section>
      <section className="settings-card danger-zone">
        <h2>
          <Trash2 size={17} aria-hidden /> Delete this workspace
        </h2>
        <p>
          Disconnect active mailboxes first. Deleting removes this workspace’s
          application history, evidence, reviews, and sessions. Type DELETE to
          confirm.
        </p>
        <div className="field-row">
          <label className="field">
            Confirmation
            <input
              value={deletion}
              onChange={(e) => setDeletion(e.target.value)}
              placeholder="DELETE"
              aria-label="Deletion confirmation"
              autoComplete="off"
            />
          </label>
          <button
            className="danger-button"
            disabled={busy || deletion !== "DELETE"}
            onClick={() => remove(deletion)}
          >
            Delete workspace
          </button>
        </div>
      </section>
    </>
  );
}
