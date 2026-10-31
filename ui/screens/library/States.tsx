import type { ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { notesErrorText, type NotesErrorCode } from "./host.ts";

export function NoFolder({ onChoose, error, hostAvailable }: { onChoose: () => void; error: NotesErrorCode | null; hostAvailable: boolean }): ReactNode {
  return (
    <div className="lib-nofolder" role="region" aria-label="Choose a notes folder">
      <h2>Choose your notes folder</h2>
      <p className="lib-muted">
        The Library reads meeting notes and source notes as files from one folder on this computer. It never changes them. Pick the folder the LLM-IDE
        Mac app writes to, or any folder of Markdown notes.
      </p>
      {error && <StatusBanner severity={error === "invalid_root" ? "error" : "warning"} message={notesErrorText(error)} />}
      {hostAvailable ? (
        <button type="button" className="lib-btn lib-btn-primary" onClick={onChoose}>
          Choose folder…
        </button>
      ) : (
        <StatusBanner severity="info" message={notesErrorText("unavailable")} />
      )}
    </div>
  );
}

export function LoadError({ code, onRetry }: { code: NotesErrorCode; onRetry: () => void }): ReactNode {
  return (
    <div className="lib-nofolder" role="alert">
      <h2>Could not read the notes folder</h2>
      <StatusBanner severity="error" message={notesErrorText(code)} />
      <button type="button" className="lib-btn" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
