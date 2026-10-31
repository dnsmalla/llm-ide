// Chips above the textarea: invoked skills and attachments. Names and labels are text (never a path outside the
// project), progress is a real <progress>, image previews are blob URLs revoked by the manager.
import type { AttachmentItem } from "./manager";
import type { SkillChip } from "../slash/menu";

export interface ChipsProps {
  skills: readonly SkillChip[];
  attachments: readonly AttachmentItem[];
  notices: readonly string[];
  message: string | null;
  onRemoveSkill: (id: string) => void;
  onRemoveAttachment: (id: string) => void;
  onDismissNotices: () => void;
}

const fmtSize = (n: number): string => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

export function ComposerChips(p: ChipsProps) {
  if (p.skills.length === 0 && p.attachments.length === 0 && p.notices.length === 0 && !p.message) return null;
  return (
    <div className="chat-chips">
      {p.skills.length > 0 && (
        <ul className="chat-chip-row" aria-label="Skills for this message">
          {p.skills.map((s) => (
            <li key={s.id} className="chat-chip" data-kind="skill">
              <span className="chat-chip-name">{s.name}</span>
              <button type="button" className="chat-chip-x" aria-label={`Remove skill ${s.name}`} onClick={() => p.onRemoveSkill(s.id)}>{"×"}</button>
            </li>
          ))}
        </ul>
      )}
      {p.attachments.length > 0 && (
        <ul className="chat-chip-row" aria-label="Attachments">
          {p.attachments.map((a) => (
            <li key={a.id} className="chat-chip" data-kind={a.kind} data-status={a.status}>
              {a.previewUrl && <img className="chat-chip-thumb" src={a.previewUrl} alt="" width={28} height={28} />}
              <span className="chat-chip-name" title={a.label}>{a.label}</span>
              {a.status === "reading" && <progress className="chat-chip-progress" max={1} value={a.progress} aria-label={`Reading ${a.label}`} />}
              {a.status === "ready" && <span className="chat-muted">{a.kind === "image" ? fmtSize(a.size) : `${a.chars.toLocaleString("en-US")} chars`}{a.truncated ? ", cut to the limit" : ""}</span>}
              {a.status === "error" && <span role="alert" className="chat-error">{a.error}</span>}
              <button type="button" className="chat-chip-x" aria-label={a.status === "reading" ? `Cancel reading ${a.label}` : `Remove attachment ${a.label}`} onClick={() => p.onRemoveAttachment(a.id)}>{"×"}</button>
            </li>
          ))}
        </ul>
      )}
      {p.notices.length > 0 && (
        <div role="status" className="chat-chip-notices">
          {p.notices.map((n, i) => <span key={i} className="chat-muted">{n} </span>)}
          <button type="button" className="chat-link-btn" onClick={p.onDismissNotices}>Dismiss</button>
        </div>
      )}
      {p.message && <div role="status" className="chat-muted">{p.message}</div>}
    </div>
  );
}
