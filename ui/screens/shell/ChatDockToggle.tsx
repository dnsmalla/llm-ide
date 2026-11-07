// One Code Assistant toggle for every section that docks chat: same icon, label, state and controls target.
import { Icon } from "@llmide/ui-kit";

export function ChatDockToggle({ open, controls, onToggle, disabled = false }: { open: boolean; controls: string; onToggle(): void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="ui-icon-button chat-dock-toggle"
      aria-label={open ? "Close Code Assistant" : "Open Code Assistant"}
      aria-controls={controls}
      aria-expanded={open}
      disabled={disabled}
      title={disabled ? "The window is too narrow for the Code Assistant" : open ? "Close the Code Assistant" : "Open the Code Assistant"}
      onClick={onToggle}
    >
      <Icon name="panel-right" size={16} />
    </button>
  );
}
