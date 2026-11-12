// Turn options above the composer, one compact row: a mode chip and a model chip (each opens a Sheet with the choices), an
// attach button and, when the browser can dictate, a mic. Mode and model are Host API v1 `compose`; attachments are text
// files (capability chat). The mic drives the kit Composer's own Dictate button (its speech handling and Cmd+M stay as
// they are); that button is hidden in the dock (web.css) so the row stays one line.
import { useEffect, useRef, useState, type RefObject } from "react";
import { MODES } from "@llmide/screens/chat/route.ts";
import type { ComposeState } from "../chat/compose.ts";
import { ACCEPT, ATTACH_LIMITS } from "../chat/attachments.ts";
import { Button, IconButton, ListRow, RowList, Sheet, UiIcon } from "../ui/index.ts";

export interface ComposeBarProps {
  state: ComposeState; canChoose: boolean; disabled: boolean;
  onMode: (m: string) => void; onModel: (id: string) => void;
  onFiles: (files: FileList | null) => void; onRemove: (i: number) => void;
  /** The mode is not a choice here (the Execute chat): the chip names it, and its sheet only explains it. */
  fixedMode?: string;
  /** What the mode sheet (and the chip's tooltip) says about what this chat can do. */
  hint?: string;
}

export const ASK_HINT = "Runs read-only on the desktop: no file edits or commands from the web.";
export const EXECUTE_HINT = "Edits files and runs commands on the desktop. You approve each step from here.";
const DICTATE_BUTTON = '.chat-composer-bar button[aria-label="Dictate a message"], .chat-composer-bar button[aria-label="Stop dictation"]';

const modeLabel = (id: string) => MODES.find((m) => m.id === id)?.label ?? (id === "execute" ? "Execute" : id);

/** Mirrors the kit Composer's Dictate button (same dock) so one speech recogniser serves both; absent without speech recognition. */
function useDictation(root: RefObject<HTMLElement | null>) {
  const [st, setSt] = useState({ supported: false, listening: false });
  const find = () => root.current?.closest(".web-dock")?.querySelector<HTMLButtonElement>(DICTATE_BUTTON) ?? null;
  useEffect(() => {
    const btn = find();
    if (!btn) return undefined;
    const sync = () => setSt({ supported: !btn.disabled, listening: btn.getAttribute("aria-pressed") === "true" });
    sync();
    if (typeof MutationObserver === "undefined") return undefined;
    const mo = new MutationObserver(sync);
    mo.observe(btn, { attributes: true, attributeFilter: ["aria-pressed", "disabled", "aria-label"] });
    return () => mo.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { ...st, toggle: () => find()?.click() };
}

export function ComposeBar(p: ComposeBarProps) {
  const s = p.state;
  const full = s.attachments.length >= ATTACH_LIMITS.maxFiles;
  const root = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [sheet, setSheet] = useState<"mode" | "model" | null>(null);
  const dictation = useDictation(root);
  const mode = p.fixedMode ?? s.mode;
  const hint = p.hint ?? (p.fixedMode === "execute" ? EXECUTE_HINT : ASK_HINT);
  const model = s.models.find((m) => m.model === s.model);
  const modelName = model ? (model.label ?? model.model) : "Desktop default";
  const close = () => setSheet(null);
  return (
    <div className="web-compose" role="group" aria-label="Message options" ref={root}>
      <div className="web-compose-row">
        {p.canChoose && (
          <>
            {p.fixedMode ? (
              <span className="ui-chip" data-static="true" title={hint}><span>{modeLabel(mode)}</span></span>
            ) : (
              <button type="button" className="ui-chip" aria-label={`Mode: ${modeLabel(mode)}`} aria-haspopup="dialog" title={hint} disabled={p.disabled} onClick={() => setSheet("mode")}>
                <span>{modeLabel(mode)}</span><UiIcon name="chevron-down" size={14} />
              </button>
            )}
            <button type="button" className="ui-chip" data-grow="true" aria-label={`Model: ${modelName}`} aria-haspopup="dialog" disabled={p.disabled} onClick={() => setSheet("model")}>
              <span>{modelName}</span><UiIcon name="chevron-down" size={14} />
            </button>
          </>
        )}
        <span className="web-compose-spacer" />
        <IconButton icon="paperclip" label="Attach text files" disabled={p.disabled || full} onClick={() => file.current?.click()} />
        <input ref={file} className="ui-sr-only" type="file" multiple accept={ACCEPT} tabIndex={-1} aria-hidden="true" disabled={p.disabled || full}
          onChange={(e) => { p.onFiles(e.currentTarget.files); e.currentTarget.value = ""; }} />
        {dictation.supported && (
          <IconButton icon="mic" label={dictation.listening ? "Stop dictation" : "Dictate a message"} variant={dictation.listening ? "primary" : "plain"} aria-pressed={dictation.listening} onClick={dictation.toggle} />
        )}
      </div>
      {s.attachments.length > 0 && (<ul className="chat-chip-row" aria-label="Attachments">{s.attachments.map((a, i) => (
        <li key={`${i}-${a.name}`} className="chat-chip"><span className="chat-chip-name">{a.name}</span><span className="chat-muted">{a.text.length.toLocaleString("en-US")} chars{a.truncated ? ", cut to the limit" : ""}</span><button type="button" className="chat-chip-x" aria-label={`Remove ${a.name}`} onClick={() => p.onRemove(i)}>{"×"}</button></li>
      ))}</ul>)}
      {s.error && <p role="alert" className="web-error">{s.error}</p>}
      <Sheet open={sheet === "mode"} onClose={close} title="Mode" footer={<Button variant="primary" onClick={close}>Done</Button>}>
        <RowList label="Mode">
          {(p.fixedMode ? [p.fixedMode] : s.modes).map((m) => (
            <li key={m}><ListRow title={modeLabel(m)} selected={m === mode} trailing={m === mode ? <UiIcon name="check" size={16} /> : undefined}
              onClick={() => { if (!p.fixedMode) p.onMode(m); close(); }} /></li>
          ))}
        </RowList>
        <p className="ui-hint">{hint}</p>
      </Sheet>
      <Sheet open={sheet === "model"} onClose={close} title="Model" footer={<Button variant="primary" onClick={close}>Done</Button>}>
        <RowList label="Model">
          <li><ListRow title="Desktop default" subtitle="Whatever the desktop is set to use" selected={s.model === null} trailing={s.model === null ? <UiIcon name="check" size={16} /> : undefined} onClick={() => { p.onModel(""); close(); }} /></li>
          {s.models.map((m) => (
            <li key={m.model}><ListRow title={m.label ?? m.model} selected={m.model === s.model} trailing={m.model === s.model ? <UiIcon name="check" size={16} /> : undefined}
              onClick={() => { p.onModel(m.model); close(); }} /></li>
          ))}
        </RowList>
      </Sheet>
    </div>
  );
}
