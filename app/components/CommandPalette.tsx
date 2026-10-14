import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Cloud,
  CornerDownLeft,
  Inbox,
  LayoutDashboard,
  Moon,
  Search,
  Settings,
  Upload,
} from "lucide-react";
import type { OpeningView } from "../../src/server/queries.ts";
import { CompanyMark, Kbd } from "./ui.tsx";
import { statusOf, label, type Screen } from "../lib.ts";

type Item = {
  id: string;
  group: "Go to" | "Applications" | "Actions";
  title: string;
  hint?: string;
  icon?: React.ReactNode;
  company?: string;
  run: () => void;
};

/**
 * ⌘K / Ctrl+K: jump to any application or screen without leaving the keyboard.
 * A dialog with a combobox and listbox, so screen readers announce the active option.
 */
export function CommandPalette({
  open,
  onClose,
  openings,
  reviews,
  go,
  openApplication,
  cycleTheme,
}: {
  open: boolean;
  onClose: () => void;
  openings: OpeningView[];
  reviews: number;
  go: (screen: Screen) => void;
  openApplication: (id: string) => void;
  cycleTheme: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const done = (fn: () => void) => () => {
      onClose();
      fn();
    };
    const all: Item[] = [
      { id: "s-app", group: "Go to", title: "Applications", icon: <LayoutDashboard size={16} />, run: done(() => go("applications")) },
      { id: "s-rev", group: "Go to", title: "Needs review", hint: reviews ? `${reviews} waiting` : "All caught up", icon: <Inbox size={16} />, run: done(() => go("review")) },
      { id: "s-imp", group: "Go to", title: "Import emails", icon: <Upload size={16} />, run: done(() => go("import")) },
      { id: "s-con", group: "Go to", title: "Connections", icon: <Cloud size={16} />, run: done(() => go("connections")) },
      { id: "s-set", group: "Go to", title: "Workspace settings", icon: <Settings size={16} />, run: done(() => go("settings")) },
      ...openings.map<Item>((o) => ({
        id: o.id,
        group: "Applications",
        title: `${o.company} — ${o.title}`,
        hint: o.attempts.map((a) => label(statusOf(a))).join(" · "),
        company: o.company,
        run: done(() => openApplication(o.id)),
      })),
      { id: "a-theme", group: "Actions", title: "Switch appearance", hint: "System · Light · Dark", icon: <Moon size={16} />, run: () => cycleTheme() },
    ];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    // Every typed word must appear somewhere: "acme back" finds "Acme — Backend Engineer".
    return all.filter((item) =>
      q
        .split(/\s+/)
        .every((w) => `${item.title} ${item.hint ?? ""}`.toLowerCase().includes(w)),
    );
  }, [query, openings, reviews, go, openApplication, onClose, cycleTheme]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;
  const groups = ["Go to", "Applications", "Actions"] as const;
  let n = -1;
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => Math.min(items.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            items[index]?.run();
          }
        }}
      >
        <label className="palette-search">
          <Search size={18} aria-hidden />
          <input
            ref={input}
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[index] ? `pal-${items[index]!.id}` : undefined}
            aria-label="Search applications and pages"
            placeholder="Search applications, pages, actions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Kbd>Esc</Kbd>
        </label>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {items.length === 0 && (
            <p className="palette-empty">Nothing matches “{query}”.</p>
          )}
          {groups.map((group) => {
            const inGroup = items.filter((i) => i.group === group);
            if (!inGroup.length) return null;
            return (
              <div key={group} role="group" aria-label={group}>
                <div className="palette-group">{group}</div>
                {inGroup.map((item) => {
                  n += 1;
                  const i = n;
                  return (
                    <div
                      key={item.id}
                      id={`pal-${item.id}`}
                      role="option"
                      aria-selected={i === index}
                      data-index={i}
                      className={`palette-item ${i === index ? "active" : ""}`}
                      onMouseMove={() => setIndex(i)}
                      onClick={() => item.run()}
                    >
                      {item.company ? (
                        <CompanyMark name={item.company} size="sm" />
                      ) : (
                        <span className="palette-icon">{item.icon}</span>
                      )}
                      <span className="palette-title">{item.title}</span>
                      {item.hint && <span className="palette-hint">{item.hint}</span>}
                      {i === index ? (
                        <CornerDownLeft size={14} className="palette-enter" aria-hidden />
                      ) : (
                        <ArrowRight size={14} className="palette-enter faint" aria-hidden />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="palette-foot" aria-hidden>
          <span><Kbd>↑</Kbd><Kbd>↓</Kbd> to move</span>
          <span><Kbd>↵</Kbd> to open</span>
          <span><Kbd>/</Kbd> search the ledger</span>
        </div>
      </div>
    </div>
  );
}
