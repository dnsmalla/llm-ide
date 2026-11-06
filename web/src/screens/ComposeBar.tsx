// Turn options beside the composer: mode and model (Host API v1 `compose`) and text attachments (capability chat).
// Native controls with visible labels, so keyboard and VoiceOver work as they do on the desktop pickers.
import { MODES } from "@llmide/screens/chat/route.ts";
import type { ComposeState } from "../chat/compose.ts";
import { ACCEPT, ATTACH_LIMITS } from "../chat/attachments.ts";
export interface ComposeBarProps {
  state: ComposeState; canChoose: boolean; disabled: boolean;
  onMode: (m: string) => void; onModel: (id: string) => void;
  onFiles: (files: FileList | null) => void; onRemove: (i: number) => void;
}
const modeLabel = (id: string) => MODES.find((m) => m.id === id)?.label ?? id;
export function ComposeBar(p: ComposeBarProps) {
  const s = p.state; const full = s.attachments.length >= ATTACH_LIMITS.maxFiles;
  return (
    <div className="web-compose" role="group" aria-label="Message options">
      {p.canChoose && s.modes.length > 0 && (
        <label className="chat-pick"><span className="chat-pick-label">Mode</span>
          <select aria-label="Mode" value={s.mode} disabled={p.disabled} onChange={(e) => p.onMode(e.target.value)}>{s.modes.map((m) => <option key={m} value={m}>{modeLabel(m)}</option>)}</select>
        </label>
      )}
      {p.canChoose && (
        <label className="chat-pick"><span className="chat-pick-label">Model</span>
          <select aria-label="Model" value={s.model ?? ""} disabled={p.disabled} onChange={(e) => p.onModel(e.target.value)}>
            <option value="">Desktop default</option>{s.models.map((m) => <option key={m.model} value={m.model}>{m.label ?? m.model}</option>)}
          </select>
        </label>
      )}
      <label className="web-attach">Attach text files
        <input type="file" multiple accept={ACCEPT} disabled={p.disabled || full} onChange={(e) => { p.onFiles(e.currentTarget.files); e.currentTarget.value = ""; }} />
      </label>
      {s.attachments.length > 0 && (<ul className="chat-chip-row" aria-label="Attachments">{s.attachments.map((a, i) => (
        <li key={`${i}-${a.name}`} className="chat-chip"><span className="chat-chip-name">{a.name}</span><span className="chat-muted">{a.text.length.toLocaleString("en-US")} chars{a.truncated ? ", cut to the limit" : ""}</span><button type="button" className="chat-chip-x" aria-label={`Remove ${a.name}`} onClick={() => p.onRemove(i)}>{"×"}</button></li>
      ))}</ul>)}
      {s.error && <p role="alert" className="web-error">{s.error}</p>}
      {p.canChoose && <p className="chat-muted">Runs read-only on the desktop: no file edits or commands from the web.</p>}
    </div>
  );
}
