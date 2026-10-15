"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  Cloud,
  Monitor,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Search,
  Settings,
  Sun,
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
import type { SyncResult } from "../src/server/gmail/sync.ts";
import { api, syncNotice, type Screen } from "./lib.ts";
import { Brand, Kbd } from "./components/ui.tsx";
import { Welcome } from "./components/Welcome.tsx";
import { ApplicationsScreen } from "./components/Applications.tsx";
import { DetailScreen } from "./components/Detail.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import {
  ConnectionsScreen,
  ImportScreen,
  ReviewScreen,
  SettingsScreen,
  type Theme,
} from "./components/Screens.tsx";

type Dashboard = {
  openings: OpeningView[];
  reviews: ReviewView[];
  mailboxes: MailboxView[];
};
type Notice = { text: string; tone: "info" | "error" } | null;

const EMPTY: Dashboard = { openings: [], reviews: [], mailboxes: [] };
const SCREENS: Screen[] = [
  "applications",
  "review",
  "connections",
  "import",
  "settings",
];
const TITLES: Record<Screen, string> = {
  applications: "Applications",
  review: "Needs review",
  connections: "Connections",
  import: "Import emails",
  settings: "Workspace settings",
};

/** `#review`, `#application/<id>` — so the browser and phone back gesture work as expected. */
function readHash(): { screen: Screen; openingId: string | null } {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const opening = /^application\/([0-9a-f-]{36})$/i.exec(raw)?.[1] ?? null;
  if (opening) return { screen: "applications", openingId: opening };
  return {
    screen: (SCREENS as string[]).includes(raw)
      ? (raw as Screen)
      : "applications",
    openingId: null,
  };
}

function storedTheme(): Theme {
  try {
    const t = window.localStorage.getItem("ledger-theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export default function Home() {
  const [session, setSession] = useState<BrowserSession | null>(null),
    [ready, setReady] = useState(false),
    [demo, setDemo] = useState(false),
    [google, setGoogle] = useState(false);
  const [data, setData] = useState<Dashboard>(EMPTY),
    [screen, setScreen] = useState<Screen>("applications"),
    [detail, setDetail] = useState<OpeningDetail | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<Notice>(null),
    [drawer, setDrawer] = useState(false),
    [palette, setPalette] = useState(false),
    [theme, setThemeState] = useState<Theme>("system"),
    [scrolled, setScrolled] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const detailId = useRef<string | null>(null);
  detailId.current = detail?.id ?? null;
  const onLedger = useRef(true);
  onLedger.current = screen === "applications" && !detail;

  const info = (text: string) => setNotice({ text, tone: "info" });

  async function refresh() {
    setData(await api<Dashboard>("dashboard"));
    if (detailId.current)
      setDetail(await api<OpeningDetail>(`openings/${detailId.current}`));
  }

  async function loadDetail(id: string) {
    try {
      setDetail(await api<OpeningDetail>(`openings/${id}`));
    } catch {
      setDetail(null);
    }
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
      setData(state.session ? await api<Dashboard>("dashboard") : EMPTY);
      setSession(state.session);
      if (state.session) {
        const route = readHash();
        setScreen(route.screen);
        if (route.openingId) await loadDetail(route.openingId);
      }
    } catch (error) {
      setSession(null);
      setData(EMPTY);
      setNotice({ text: (error as Error).message, tone: "error" });
    } finally {
      setReady(true);
    }
  }

  useEffect(() => {
    setThemeState(storedTheme());
    void boot();
    if (new URL(window.location.href).searchParams.has("authError"))
      setNotice({
        text: "Google sign-in could not be completed. Please try again.",
        tone: "error",
      });
    const onPop = () => {
      const route = readHash();
      setScreen(route.screen);
      setDrawer(false);
      if (route.openingId) void loadDetail(route.openingId);
      else setDetail(null);
    };
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("popstate", onPop);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  // Theme: "system" leaves the attribute off so CSS follows prefers-color-scheme.
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      window.localStorage.setItem("ledger-theme", theme);
    } catch {
      /* private mode: the choice simply lasts for this visit */
    }
  }, [theme]);
  const cycleTheme = useCallback(
    () =>
      setThemeState((t) =>
        t === "system" ? "light" : t === "light" ? "dark" : "system",
      ),
    [],
  );

  // Informational toasts fade on their own; errors stay until dismissed.
  useEffect(() => {
    if (notice?.tone !== "info") return;
    const t = window.setTimeout(() => setNotice(null), 9000);
    return () => window.clearTimeout(t);
  }, [notice]);

  // The open drawer behaves like a dialog: no background scroll, Escape closes it.
  useEffect(() => {
    document.body.classList.toggle("locked", !!session && (drawer || palette));
  }, [drawer, palette, session]);

  const push = (hash: string, state: unknown = null, replace = false) => {
    const target = hash === "#" ? "" : hash;
    if (window.location.hash === target) return;
    const url = target || window.location.pathname + window.location.search;
    if (replace) window.history.replaceState(state, "", url);
    else window.history.pushState(state, "", url);
  };
  const go = useCallback((next: Screen) => {
    setScreen(next);
    setDetail(null);
    setDrawer(false);
    setNotice((n) => (n?.tone === "error" ? null : n));
    push(next === "applications" ? "#" : `#${next}`);
    window.scrollTo({ top: 0 });
  }, []);
  const openApplication = useCallback(
    (id: string) =>
      void work(async () => {
        const fromLedger = onLedger.current;
        setDetail(await api<OpeningDetail>(`openings/${id}`));
        setScreen("applications");
        // Marked so closing can step back to the list instead of stacking another entry.
        push(`#application/${id}`, fromLedger ? { fromLedger: true } : null);
        window.scrollTo({ top: 0 });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const closeDetail = () => {
    // Opened from the list: go back, so history stays list → detail, not list → detail → list.
    if ((window.history.state as { fromLedger?: boolean } | null)?.fromLedger) {
      window.history.back();
      return;
    }
    setDetail(null);
    push("#", null, true);
  };

  // Global shortcuts. Typing in a field never triggers them, except Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing =
        /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
        target.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (e.key === "Escape") {
        if (drawer) setDrawer(false);
        else if (!typing && detail && !palette) closeDetail();
        return;
      }
      if (typing || palette) return;
      if (e.key === "/" && screen === "applications" && !detail) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function work(fn: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
    } catch (error) {
      setNotice({ text: (error as Error).message, tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  const signOut = () =>
    void work(async () => {
      await api("logout", {});
      setDrawer(false);
      setPalette(false);
      setSession(null);
      setDetail(null);
      setData(EMPTY);
      push("#");
    });

  const nav = [
    {
      id: "applications",
      title: "Applications",
      short: "Ledger",
      icon: LayoutDashboard,
    },
    { id: "review", title: "Needs review", short: "Review", icon: Inbox },
    { id: "connections", title: "Connections", short: "Accounts", icon: Cloud },
    { id: "import", title: "Import emails", short: "Import", icon: Upload },
  ] as const;
  const reviews = data.reviews.length;
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iP(hone|ad)/.test(navigator.platform);

  if (!ready)
    return (
      <div
        className="loading"
        aria-busy="true"
        aria-label="Opening your ledger"
      >
        <Brand />
        <div className="skeleton">
          <span className="sk sk-title" />
          <span className="sk sk-line" />
          <div className="sk-row">
            <span className="sk sk-card" />
            <span className="sk sk-card" />
            <span className="sk sk-card" />
          </div>
          <span className="sk sk-block" />
        </div>
        <span className="loading-text">Opening your ledger…</span>
      </div>
    );

  if (!session)
    return (
      <Welcome
        demo={demo}
        google={google}
        busy={busy}
        notice={notice?.text ?? ""}
        startDemo={() =>
          void work(async () => {
            await api("demo", {});
            await boot();
          })
        }
      />
    );

  const current = detail ? detail.company : TITLES[screen];

  return (
    <div className="shell">
      {/* Focus without touching the URL hash, which carries the current route. */}
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Skip to content
      </a>
      <div
        className={`drawer-backdrop ${drawer ? "show" : ""}`}
        onClick={() => setDrawer(false)}
        aria-hidden
      />
      <aside
        className={`sidebar ${drawer ? "show" : ""}`}
        aria-label="Workspace"
      >
        <div className="sidebar-top">
          <Brand />
          <button
            className="icon-button drawer-close"
            aria-label="Close navigation"
            onClick={() => setDrawer(false)}
          >
            <X size={18} />
          </button>
        </div>
        <button className="palette-trigger" onClick={() => setPalette(true)}>
          <Search size={15} aria-hidden />
          <span>Jump to…</span>
          <span className="keys" aria-hidden>
            <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav>
          {nav.map((item) => (
            <button
              key={item.id}
              className={
                screen === item.id && !detail
                  ? "selected"
                  : screen === item.id
                    ? "within"
                    : ""
              }
              aria-current={screen === item.id ? "page" : undefined}
              onClick={() => go(item.id)}
            >
              <item.icon size={18} aria-hidden />
              <span>{item.title}</span>
              {item.id === "review" && reviews > 0 && <b>{reviews}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-card">
          <h3>
            Your next chapter
            <br />
            is taking shape.
          </h3>
          <p>One application at a time.</p>
        </div>
        <div className="sidebar-bottom">
          <button
            className={screen === "settings" ? "selected" : ""}
            onClick={() => go("settings")}
          >
            <Settings size={17} aria-hidden />
            Workspace settings
          </button>
          <div className="profile">
            <span className="avatar" aria-hidden>
              {session.isDemo ? "D" : session.email?.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>
                {session.isDemo ? "Demo workspace" : session.email}
              </strong>
              <small>
                {session.isDemo ? "Your own sample data" : "Private workspace"}
              </small>
            </div>
            <button
              aria-label={`Appearance: ${theme}`}
              title={`Appearance: ${theme}`}
              className="icon-button"
              onClick={cycleTheme}
            >
              {theme === "dark" ? (
                <Moon size={16} />
              ) : theme === "light" ? (
                <Sun size={16} />
              ) : (
                <Monitor size={16} />
              )}
            </button>
            <button
              aria-label="Sign out"
              className="icon-button"
              disabled={busy}
              onClick={signOut}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main" id="main" ref={mainRef} tabIndex={-1}>
        <div className={`topbar ${scrolled ? "scrolled" : ""}`}>
          <button
            className="mobile-menu icon-button"
            aria-label="Toggle navigation"
            aria-expanded={drawer}
            onClick={() => setDrawer(!drawer)}
          >
            <Menu size={20} />
          </button>
          <span className="crumbs">
            <span className="crumb-root">Workspace</span>
            <ChevronRight size={13} aria-hidden />
            {detail ? (
              <>
                <button className="crumb-link" onClick={closeDetail}>
                  Applications
                </button>
                <ChevronRight size={13} aria-hidden />
              </>
            ) : null}
            <span className="crumb-current">{current}</span>
          </span>
          <div className="topbar-right">
            {session.isDemo && <span className="demo-tag">SAMPLE</span>}
            <span
              className={`top-status ${busy ? "busy" : ""}`}
              aria-live="polite"
            >
              <i aria-hidden />{" "}
              <span className="status-text">
                {busy ? "Saving…" : "All changes saved"}
              </span>
            </span>
            <button
              className="icon-button top-search"
              aria-label="Open command menu"
              onClick={() => setPalette(true)}
            >
              <Search size={18} />
            </button>
          </div>
        </div>

        <div className="content" key={detail ? `d-${detail.id}` : screen}>
          {detail ? (
            <DetailScreen
              detail={detail}
              busy={busy}
              back={closeDetail}
              setEvent={(eventId, state) =>
                void work(async () => {
                  await api("event", { eventId, state });
                  await refresh();
                  info(
                    state === "REJECTED"
                      ? "Update rejected. The timeline was recalculated — you can restore it any time."
                      : "Update restored to the timeline.",
                  );
                })
              }
              setRoundStart={(eventId, startsRound) =>
                void work(async () => {
                  await api("event-round", { eventId, startsRound });
                  await refresh();
                  info(
                    startsRound
                      ? "Marked as the start of a new round."
                      : "No longer marked as a new round.",
                  );
                })
              }
              saveDate={(attemptId, occurredAt) =>
                void work(async () => {
                  await api("submission-date", { attemptId, occurredAt });
                  await refresh();
                })
              }
              saveStatus={(attemptId, stage, outcome) =>
                void work(async () => {
                  await api("status", { attemptId, stage, outcome });
                  await refresh();
                  info("Correction recorded on the timeline.");
                })
              }
            />
          ) : screen === "applications" ? (
            <ApplicationsScreen
              session={session}
              openings={data.openings}
              reviews={reviews}
              busy={busy}
              searchRef={search}
              open={openApplication}
              goImport={() => go("import")}
              goReview={() => go("review")}
            />
          ) : screen === "review" ? (
            <ReviewScreen
              reviews={data.reviews}
              openings={data.openings}
              busy={busy}
              goApplications={() => go("applications")}
              submit={(body) =>
                void work(async () => {
                  await api("review", body);
                  await refresh();
                })
              }
            />
          ) : screen === "import" ? (
            <ImportScreen
              busy={busy}
              work={(fn) => void work(fn)}
              refresh={refresh}
              goApplications={() => go("applications")}
              goReview={() => go("review")}
            />
          ) : screen === "connections" ? (
            <ConnectionsScreen
              session={session}
              mailboxes={data.mailboxes}
              google={google}
              busy={busy}
              sync={(mailboxId) =>
                void work(async () => {
                  const result = await api<{ runs: SyncResult[] }>("sync", {
                    mailboxId,
                  });
                  await refresh();
                  info(syncNotice(result.runs));
                })
              }
              recheck={(mailboxId) =>
                void work(async () => {
                  const result = await api<{ runs: SyncResult[] }>("recheck", {
                    mailboxId,
                  });
                  await refresh();
                  info(syncNotice(result.runs, true));
                })
              }
              retry={(mailboxId) =>
                void work(async () => {
                  await api("retry-failed", { mailboxId });
                  await refresh();
                })
              }
              disconnect={(mailboxId) =>
                void work(async () => {
                  const result = await api<{ revoked: boolean }>("disconnect", {
                    mailboxId,
                  });
                  await refresh();
                  if (!result.revoked)
                    info(
                      "Disconnected here. Google could not confirm revocation; remove Ledger’s access in your Google account settings.",
                    );
                })
              }
              connect={() =>
                void work(async () => {
                  const result = await api<{ url: string }>("connect", {
                    dedicated: true,
                  });
                  window.location.assign(result.url);
                })
              }
            />
          ) : (
            <SettingsScreen
              session={session}
              busy={busy}
              theme={theme}
              setTheme={setThemeState}
              remove={(confirm) =>
                void work(async () => {
                  await api("delete-account", { confirm });
                  setDrawer(false);
                  setSession(null);
                  setDetail(null);
                  setData(EMPTY);
                  push("#");
                })
              }
            />
          )}
        </div>
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

      <nav className="tabbar" aria-label="Quick navigation">
        {nav.map((item) => (
          <button
            key={item.id}
            className={screen === item.id ? "on" : ""}
            aria-current={screen === item.id ? "page" : undefined}
            onClick={() =>
              screen === item.id && detail ? closeDetail() : go(item.id)
            }
          >
            <span className="tab-icon">
              <item.icon size={20} aria-hidden />
              {item.id === "review" && reviews > 0 && (
                <b aria-hidden>{reviews}</b>
              )}
            </span>
            <span>{item.short}</span>
          </button>
        ))}
      </nav>

      {notice && (
        <div className="toast-region">
          <div role="alert" className={`notice ${notice.tone}`}>
            <span>{notice.text}</span>
            <button
              className="icon-button"
              aria-label="Dismiss notification"
              onClick={() => setNotice(null)}
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        openings={data.openings}
        reviews={reviews}
        go={go}
        openApplication={openApplication}
        cycleTheme={cycleTheme}
      />
    </div>
  );
}
