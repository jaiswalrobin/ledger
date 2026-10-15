import { ArrowUpRight, Check, Inbox, Mail, ShieldCheck } from "lucide-react";
import { Brand, CompanyMark } from "./ui.tsx";

/** Signed-out landing: the product explains itself through a living preview, not a feature list. */
export function Welcome({
  demo,
  google,
  busy,
  notice,
  startDemo,
}: {
  demo: boolean;
  google: boolean;
  busy: boolean;
  notice: string;
  startDemo: () => void;
}) {
  return (
    <main className="welcome">
      <header className="welcome-header">
        <Brand />
        <span className="welcome-note">
          A little clarity for your next chapter
        </span>
      </header>
      <div className="welcome-grid">
        <section className="welcome-copy">
          <div className="eyebrow">YOUR JOB SEARCH, WITH PERSPECTIVE</div>
          <h1>
            Every application.
            <br />
            <em>One clear story.</em>
          </h1>
          <p className="lede">
            Ledger reads the confirmations, invitations and replies you choose,
            and turns them into an honest timeline. No spreadsheet. No guessing.
          </p>
          <div className="welcome-actions">
            {demo && (
              <button
                className="primary large"
                disabled={busy}
                onClick={startDemo}
              >
                {busy ? "Preparing your workspace…" : "Explore the demo"}
                <ArrowUpRight size={17} aria-hidden />
              </button>
            )}
            {google ? (
              <a className="secondary large" href="/api/oauth/login">
                <GoogleMark />
                Sign in with Google
              </a>
            ) : (
              <span className="muted small">
                Try the sample workspace. Your own account stays separate.
              </span>
            )}
          </div>
          {notice && (
            <div role="alert" className="notice error inline">
              <span>{notice}</span>
            </div>
          )}
          <ul className="welcome-points">
            <li>
              <Check size={15} aria-hidden />
              <span>
                <strong>Independent attempts.</strong> Applied twice? Each
                attempt keeps its own outcome.
              </span>
            </li>
            <li>
              <Check size={15} aria-hidden />
              <span>
                <strong>Evidence for every change.</strong> Each update points
                back to the email behind it.
              </span>
            </li>
            <li>
              <Check size={15} aria-hidden />
              <span>
                <strong>Silence is never a rejection.</strong> Unclear mail
                waits for you instead of guessing.
              </span>
            </li>
          </ul>
          <div className="welcome-trust">
            <ShieldCheck size={16} aria-hidden />
            Your primary inbox stays yours. Import only the emails you choose.
          </div>
        </section>

        <div className="welcome-stage" aria-hidden>
          <div className="float-card mail">
            <span className="float-icon">
              <Mail size={15} />
            </span>
            <span>
              <strong>Interview invitation</strong>
              <small>Northwind Labs · just now</small>
            </span>
          </div>
          <div className="preview-card">
            <div className="preview-head">
              <CompanyMark name="Northwind Labs" />
              <div>
                <strong>Data Engineer</strong>
                <small>Northwind Labs · Remote</small>
              </div>
              <span className="pill interview">Interview</span>
            </div>
            <ol className="stage-track">
              <li className="done">
                <span className="dot">
                  <Check size={11} strokeWidth={3} />
                </span>
                <span className="name">Applied</span>
              </li>
              <li className="done">
                <span className="dot">
                  <Check size={11} strokeWidth={3} />
                </span>
                <span className="name">Assessment</span>
              </li>
              <li className="current">
                <span className="dot" />
                <span className="name">Interview</span>
              </li>
              <li className="todo">
                <span className="dot" />
                <span className="name">Outcome</span>
              </li>
            </ol>
            <div className="preview-timeline">
              <div className="pt-row new">
                <i className="interview" />
                <span>
                  <strong>Interview invited</strong>
                  <small>From your connected inbox</small>
                </span>
                <time>Today</time>
              </div>
              <div className="pt-row">
                <i className="assessment" />
                <span>
                  <strong>Assessment invited</strong>
                  <small>Coding challenge link received</small>
                </span>
                <time>Oct 8</time>
              </div>
              <div className="pt-row">
                <i className="applied" />
                <span>
                  <strong>Confirmation received</strong>
                  <small>Thanks for applying to Northwind</small>
                </span>
                <time>Oct 6</time>
              </div>
            </div>
          </div>
          <div className="float-card review">
            <span className="float-icon">
              <Inbox size={15} />
            </span>
            <span>
              <strong>1 update needs you</strong>
              <small>Which attempt does this belong to?</small>
            </span>
          </div>
        </div>
      </div>
      <footer className="welcome-footer">
        <span>LEDGER · Quietly organized. Clearly evidenced.</span>
        <span>First version · private preview</span>
      </footer>
    </main>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}
