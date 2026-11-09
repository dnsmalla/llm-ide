// The status bar's bell (Mac `ActivityBell`): unread badge, popover with the last 48 hours grouped by day.
// Polls the core only while mounted and signed in; opening marks everything seen. Server text is rendered as text.
import { memo, useEffect, useId, useRef, useState } from "react";
import { BellIcon } from "@llmide/ui-kit";
import { badgeText, groupByDay, visibleItems } from "./activity-model";
import { activityStore } from "./runtime";
import { shellBus } from "./bus";
import type { SectionId } from "./sections";
import { useActivityFeed, useCoreSession } from "./use-shell";

/** The popover body: pure of the store so it renders (and is tested) from plain props. */
const sectionFor = (it: { kind: string | null; link: string | null }): SectionId | null => {
  const hay = `${it.kind ?? ""} ${it.link ?? ""}`.toLowerCase();
  if (/task.?assign|assigned/.test(hay)) return "settings";
  if (/loop/.test(hay)) return "loop";
  if (/auto.?task|autotask/.test(hay)) return "autotasks";
  if (/issue|ticket/.test(hay)) return "issues";
  if (/gantt|schedule/.test(hay)) return "gantt";
  if (/graph/.test(hay)) return "graph";
  if (/doc.?gen|generate/.test(hay)) return "docgen";
  if (/meeting|note|library|source/.test(hay)) return "library";
  return null;
};

export function ActivityList({ items, nowMs, error, onOpen }: { items: ReturnType<typeof visibleItems>; nowMs: number; error?: string | null; onOpen?: (section: SectionId) => void }) {
  const groups = groupByDay(items, nowMs);
  return (
    <div className="sh-activity-scroll">
      {error && <p className="sh-activity-note sh-warning" role="status">Activity is unavailable right now. Showing the last known entries.</p>}
      {groups.length === 0 ? (
        <p className="sh-activity-empty">No activity in the last 48 hours</p>
      ) : (
        groups.map((g) => (
          <section key={g.label} aria-label={g.label}>
            <h3 className="sh-activity-day">{g.label}</h3>
            <ul className="sh-activity-list">
              {g.items.map((it) => {
                const section = sectionFor(it);
                const time = new Date(it.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                const body = (
                  <>
                    <span className="sh-activity-title">{it.title}</span>
                    <span className="sh-activity-kind">{it.kind ? it.kind.replaceAll("_", " ") : time}</span>
                    {section ? <span className="sh-activity-go" aria-hidden="true">›</span> : null}
                  </>
                );
                return (
                  <li key={it.id} className="sh-activity-row">
                    {section && onOpen ? (
                      <button type="button" className="sh-activity-hit" onClick={() => onOpen(section)}>{body}</button>
                    ) : body}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

export const ActivityBell = memo(function ActivityBell() {
  const { signedIn } = useCoreSession();
  const { feed, error } = useActivityFeed();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!signedIn) return undefined;
    activityStore.start();
    return () => activityStore.stop();
  }, [signedIn]);

  useEffect(() => {
    if (!open) return undefined;
    void activityStore.markSeen();
    panel.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!signedIn) return null;
  const badge = badgeText(feed.unread);
  const label = badge ? `Activity feed, ${badge} unread` : "Activity feed";
  return (
    <div className="sh-menu-root" ref={root}>
      <button
        ref={button}
        type="button"
        className="sh-statusbar-item sh-bell"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title="Activity feed"
        onClick={() => setOpen((v) => !v)}
      >
        <BellIcon size={14} />
        {badge && <span className="sh-bell-badge" aria-hidden="true">{badge}</span>}
      </button>
      {open && (
        <div
          id={panelId}
          ref={panel}
          tabIndex={-1}
          role="dialog"
          aria-label="Activity feed"
          className="sh-menu sh-menu-up sh-menu-end sh-activity"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
              button.current?.focus();
            }
          }}
        >
          <ActivityList
            items={visibleItems(feed.items, Date.now())}
            nowMs={Date.now()}
            error={error}
            onOpen={(section) => { setOpen(false); shellBus.publish({ type: "goto-section", section }); }}
          />
        </div>
      )}
    </div>
  );
});
