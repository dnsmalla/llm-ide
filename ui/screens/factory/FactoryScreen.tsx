// The Factory section: the work-item board and its editable process (system/factory-template.json).
// The Board needs Loop (auto_tasks); without it the section shows a clear notice.
import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import type { SectionProps } from "../shell/sections";
import { useFeatures } from "../shell/use-shell";
import "./factory.css";

declare const __FEATURE_AUTO_TASKS__: boolean | undefined;
// Direct compile-time guard, as in shell/screens.tsx: a build without Loop drops the Board chunk and the run manager it imports.
const Board = typeof __FEATURE_AUTO_TASKS__ === "undefined" || __FEATURE_AUTO_TASKS__ ? lazy(() => import("./Board.tsx")) : null;
const ProcessEditor = typeof __FEATURE_AUTO_TASKS__ === "undefined" || __FEATURE_AUTO_TASKS__ ? lazy(() => import("./ProcessEditor.tsx")) : null;

type FactoryTab = "board" | "process";

export function FactoryScreen({ active, projectRoot, focus }: SectionProps & { focus: { key: string | null; n: number } }): ReactNode {
  const features = useFeatures();
  const boardUsable = Board !== null && features.usable.has("auto_tasks");
  const [tab, setTab] = useState<FactoryTab>("board");
  // Entering Loop → Board always starts on the board, not on a tab left open last time.
  useEffect(() => { if (active) setTab("board"); }, [active]);
  const shown: FactoryTab = tab;
  // Mounted from the first visit on, so switching tabs keeps unsaved edits.
  const [processSeen, setProcessSeen] = useState(false);
  useEffect(() => {
    if (shown === "process") setProcessSeen(true);
  }, [shown]);
  useEffect(() => {
    if (focus.key) setTab("board");
  }, [focus.key, focus.n]);
  return (
    <div className="fx-root" data-active={active}>
      <div className="fx-tabs" role="tablist" aria-label="Factory views">
        {boardUsable ? <button type="button" role="tab" aria-selected={shown === "board"} className="fx-tab" onClick={() => setTab("board")}>Board</button> : null}
        {boardUsable && ProcessEditor ? <button type="button" role="tab" aria-selected={shown === "process"} className="fx-tab" onClick={() => setTab("process")}>Process</button> : null}
      </div>
      <div className="fx-tabpanel" role="tabpanel" hidden={shown !== "board"}>
        {boardUsable && Board ? (
          <Suspense fallback={<p className="fx-hint" role="status">Loading the board…</p>}>
            <Board active={active && shown === "board"} projectRoot={projectRoot} focus={focus} />
          </Suspense>
        ) : <p className="fx-hint" role="status">The Board needs the Loop feature. Enable it in Settings → Workspace → Features.</p>}
      </div>
      <div className="fx-tabpanel" role="tabpanel" hidden={shown !== "process"}>
        {boardUsable && ProcessEditor && processSeen ? (
          <Suspense fallback={<p className="fx-hint" role="status">Loading the process…</p>}>
            <ProcessEditor active={active && shown === "process"} projectRoot={projectRoot} />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
}
