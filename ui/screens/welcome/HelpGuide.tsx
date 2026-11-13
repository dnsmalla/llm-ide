// Help & Support: a searchable beginner guide. A Home page with paths in, clickable flowcharts (pick a box to read
// what happens there, or step with Back/Next), a tick-off "Try it" list, short questions and "Read next" links.
// Plain text only: every string comes from help.ts and renders as text.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { HELP_FLOWS, HELP_GROUPS, HELP_TOPICS, topicFlow, type FlowNode, type HelpGroup, type HelpTopic } from "./help";

const HOME = "home";
const byId = new Map(HELP_TOPICS.map((t) => [t.id, t]));

/** A flowchart of boxes joined by arrows. Clicking a box (or Back/Next, or the arrow keys) shows what happens there. */
export function FlowChart({ nodes, label }: { nodes: readonly FlowNode[]; label: string }): ReactNode {
  const [at, setAt] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const go = (i: number) => { const n = Math.max(0, Math.min(nodes.length - 1, i)); setAt(n); refs.current[n]?.focus(); };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); go(i + 1); }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); go(i - 1); }
  };
  const node = nodes[at];
  return (
    <figure className="help-flow" aria-label={label}>
      <ol className="help-flow-row">
        {nodes.map((n, i) => (
          <li key={n.label} className="help-flow-item">
            <button type="button" ref={(el) => { refs.current[i] = el; }} className="help-flow-node" data-tone={n.tone ?? "step"} data-on={i === at || undefined} data-past={i < at || undefined}
              aria-pressed={i === at} onClick={() => setAt(i)} onKeyDown={(e) => onKey(e, i)}>
              <span className="help-flow-num" aria-hidden="true">{n.tone === "end" ? "✓" : i + 1}</span>
              <span className="help-flow-label">{n.label}</span>
            </button>
            {i < nodes.length - 1 ? <span className="help-flow-arrow" aria-hidden="true" /> : null}
          </li>
        ))}
      </ol>
      {node ? (
        <figcaption className="help-flow-detail" aria-live="polite">
          <p className="help-flow-step">Step {at + 1} of {nodes.length}</p>
          <p className="help-flow-title">{node.label}</p>
          <p className="help-flow-text">{node.detail}</p>
          <div className="help-flow-nav">
            <button type="button" className="help-btn" disabled={at === 0} onClick={() => go(at - 1)}>← Back</button>
            <button type="button" className="help-btn help-btn-primary" disabled={at === nodes.length - 1} onClick={() => go(at + 1)}>Next →</button>
          </div>
        </figcaption>
      ) : null}
    </figure>
  );
}

/** The topic's steps as a list you can tick off while you follow it. */
function TryIt({ steps }: { steps: readonly string[] }): ReactNode {
  const [done, setDone] = useState<ReadonlySet<number>>(() => new Set());
  const flip = (i: number) => setDone((d) => { const n = new Set(d); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  return (
    <section className="help-section" aria-label="Try it">
      <div className="help-section-head"><h4 className="help-h4">Try it</h4><span className="help-progress">{done.size} of {steps.length} done</span></div>
      <ol className="help-try">
        {steps.map((step, i) => (
          <li key={i}>
            <button type="button" className="help-try-item" aria-pressed={done.has(i)} onClick={() => flip(i)}>
              <span className="help-try-box" aria-hidden="true">{done.has(i) ? "✓" : i + 1}</span>
              <span>{step}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Topic({ t, open, onOpen }: { t: HelpTopic; open: (id: string) => void; onOpen?: () => void }): ReactNode {
  const flow = topicFlow(t);
  return (
    <>
      <p className="help-kicker">{t.group}</p>
      <h3 className="help-title">{t.title}</h3>
      {t.oneLine ? <p className="help-oneline"><span className="help-oneline-tag">In one line</span>{t.oneLine}</p> : null}
      <p className="help-what">{t.what}</p>
      {flow ? (
        <section className="help-section" aria-label="How it works">
          <div className="help-section-head"><h4 className="help-h4">How it works</h4><span className="help-progress">Click a step</span></div>
          <FlowChart nodes={flow} label={`${t.title}: how it works`} />
        </section>
      ) : null}
      <TryIt steps={t.steps} />
      {t.example ? <p className="help-example"><strong>Example</strong>{t.example}</p> : null}
      {t.faq && t.faq.length > 0 ? (
        <section className="help-section" aria-label="Good to know">
          <h4 className="help-h4">Good to know</h4>
          <div className="help-faq">
            {t.faq.map((f) => <details key={f.q} className="help-faq-item"><summary>{f.q}</summary><p>{f.a}</p></details>)}
          </div>
        </section>
      ) : null}
      <div className="help-foot">
        {onOpen ? <button type="button" className="help-btn help-btn-primary" onClick={onOpen}>{t.group === "Settings" ? "Open Settings" : t.target ? `Open ${t.title.replace(/^Recipe: /, "")}` : "Open"} →</button> : null}
        {t.related && t.related.length > 0 ? (
          <nav className="help-related" aria-label="Read next">
            <span>Read next</span>
            {t.related.map((id) => { const r = byId.get(id); return r ? <button key={id} type="button" className="help-chip" onClick={() => open(id)}>{r.title}</button> : null; })}
          </nav>
        ) : null}
      </div>
    </>
  );
}

const PATHS: readonly { id: string; title: string; text: string; glyph: string }[] = [
  { id: "start", title: "I'm new here", text: "The first 10 minutes, step by step.", glyph: "★" },
  { id: "factory", title: "Let the AI do an issue", text: "From open issue to a draft merge request.", glyph: "⚙" },
  { id: "chat", title: "Ask about my project", text: "Questions, answers and sources.", glyph: "?" },
  { id: "settings", title: "Change a setting", text: "Keys, models, theme, phone.", glyph: "⚑" },
];

function Home({ open }: { open: (id: string) => void }): ReactNode {
  const questions = HELP_TOPICS.flatMap((t) => (t.faq ?? []).map((f) => ({ ...f, id: t.id }))).slice(0, 6);
  return (
    <>
      <p className="help-kicker">Help &amp; Support</p>
      <h3 className="help-title">How can we help?</h3>
      <p className="help-what">Pick where you want to go. Every page has a one-line answer, a flowchart you can click through, and steps you can tick off.</p>
      <div className="help-paths">
        {PATHS.map((p) => (
          <button key={p.id} type="button" className="help-path" onClick={() => open(p.id)}>
            <span className="help-path-glyph" aria-hidden="true">{p.glyph}</span>
            <span className="help-path-title">{p.title}</span>
            <span className="help-path-text">{p.text}</span>
          </button>
        ))}
      </div>
      <section className="help-section" aria-label="How it all fits together">
        <div className="help-section-head"><h4 className="help-h4">How it all fits together</h4><span className="help-progress">Click a step</span></div>
        <FlowChart nodes={HELP_FLOWS.map} label="How LLM-IDE fits together" />
      </section>
      <section className="help-section" aria-label="Common questions">
        <h4 className="help-h4">Common questions</h4>
        <div className="help-faq">
          {questions.map((f) => (
            <details key={f.q} className="help-faq-item">
              <summary>{f.q}</summary>
              <p>{f.a}</p>
              <button type="button" className="help-chip" onClick={() => open(f.id)}>More: {byId.get(f.id)?.title}</button>
            </details>
          ))}
        </div>
      </section>
    </>
  );
}

export function GuideDialog({ onClose, onNavigate, initialTopic }: { onClose: () => void; onNavigate?: (target: NonNullable<HelpTopic["target"]>, settingsGroup?: string) => void; /** Open on this topic id instead of Home. */ initialTopic?: string }): ReactNode {
  const close = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(initialTopic && byId.has(initialTopic) ? initialTopic : HOME);
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const open = (id: string) => { setActiveId(id); content.current?.scrollTo?.({ top: 0 }); };
  const q = query.trim().toLowerCase();
  const matches = (t: HelpTopic) => `${t.title} ${t.oneLine ?? ""} ${t.what} ${t.steps.join(" ")} ${t.example ?? ""} ${(t.faq ?? []).map((f) => `${f.q} ${f.a}`).join(" ")}`.toLowerCase().includes(q);
  const topics = q === "" ? HELP_TOPICS : HELP_TOPICS.filter(matches);
  const active = q === "" && activeId === HOME ? null : topics.find((t) => t.id === activeId) ?? topics[0] ?? null;
  const groupList = (group: HelpGroup) => topics.filter((t) => t.group === group);
  return (
    <div className="wc-modal" role="dialog" aria-modal="true" aria-labelledby="wc-guide-title" data-testid="guide">
      <div className="wc-modal-card help-card">
        <div className="wc-modal-head help-head">
          <div>
            <h2 id="wc-guide-title" className="wc-h2">Help &amp; Support</h2>
            <p className="help-sub">Every screen and setting, explained simply, with flowcharts you can click.</p>
          </div>
          <button ref={close} type="button" className="sh-button" onClick={onClose}>Close</button>
        </div>
        <div className="help-search">
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search: “Factory”, “API key”, “offline”…" aria-label="Search help" autoComplete="off" />
        </div>
        <div className="help-body">
          <nav className="help-nav" aria-label="Help topics">
            {q === "" ? <button type="button" className="help-nav-item help-nav-home" aria-current={activeId === HOME ? "page" : undefined} onClick={() => open(HOME)}>Home</button> : null}
            {HELP_GROUPS.map((group) => {
              const list = groupList(group);
              if (list.length === 0) return null;
              return (
                <section key={group}>
                  <h3 className="help-nav-title">{group}</h3>
                  <ul>
                    {list.map((t) => (
                      <li key={t.id} className="help-nav-row">
                        <button type="button" className="help-nav-item" aria-current={active?.id === t.id ? "page" : undefined} onClick={() => open(t.id)}>{t.title.replace(/^Recipe: /, "")}</button>
                        {t.target && onNavigate ? <button type="button" className="help-nav-go" aria-label={`Open ${t.title}`} title={`Open ${t.title}`} onClick={() => onNavigate(t.target!, t.settingsGroup)}>↗</button> : null}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            {topics.length === 0 ? <p className="help-empty">No topic matches “{query.trim()}”.</p> : null}
          </nav>
          <article className="help-content" ref={content} aria-live="polite">
            {active
              ? <Topic key={active.id} t={active} open={open} onOpen={active.target && onNavigate ? () => onNavigate(active.target!, active.settingsGroup) : undefined} />
              : q === "" ? <Home open={open} /> : null}
          </article>
        </div>
      </div>
    </div>
  );
}
