// Glue between the pure ComposerModel and the Composer: one model + attachment manager per mounted composer
// (the chat screen keys the composer by chat id, so switching chats disposes the old one and cancels its reads).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { AttachmentManager, browserBlobs, type AttachHost, type BlobUrls, type WireAttachment } from "../attach/manager";
import type { ProjectFs } from "../mentions/project-fs";
import { ComposerChips } from "../attach/AttachmentChips";
import { CompletionMenu, optionId } from "./CompletionMenu";
import { ComposerModel, type ComposerActions } from "./model";
import { runBuiltin } from "./builtin-actions";
import type { CatalogLoader } from "./loader";
import type { MentionSearch } from "../mentions";
import { MODES } from "../route";
import type { ModelGroupLike } from "./items";

/** What the host app supplies; every field is optional so a plain browser still gets a working composer. */
export interface ComposeServices {
  catalog: CatalogLoader;
  mentions: MentionSearch | null;
  attachHost: AttachHost | null;
  /** The open project's root-confined fs (mentions, plan saving); null without a project or the desktop host. */
  project: ProjectFs | null;
  blobs?: BlobUrls | null;
  /** Open a Library row (hook / MCP). */
  openLibraryTarget?: (target: { kind: "plugin" | "mcp"; id: string }) => void;
  /** Built-in section navigation ("settings", "library", "loopEngine"). */
  openSection?: (section: string) => boolean;
}

export interface SendExtra { skills?: string[]; attachments?: WireAttachment[] }

export interface ExtrasOptions {
  services: ComposeServices;
  draft: string;
  setDraft: (text: string) => void;
  models: readonly ModelGroupLike[];
  setMode: (id: string) => void;
  setModel: (provider: string, model: string) => void;
  clearChat: () => void;
  chatId: string;
  /** A turn is running: messages are queued as plain text, so attachments and skills wait for the turn to end. */
  busy?: boolean;
}

/** What the Composer renders and calls. */
export interface ComposerExtras {
  /** Runs before the composer's own key handling; true = the key was handled here. */
  onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean;
  textareaProps: Record<string, string | boolean | undefined>;
  menu: ReactNode;
  chips: ReactNode;
  toolbar: ReactNode;
  /** Holds the send while an attachment is still being read. */
  blockedReason: string | null;
  /** Folds chips and attachments in; null = the text was a built-in command and has been handled. */
  prepareSend(text: string): { text: string; extra: SendExtra } | null;
}

export function useComposerExtras(o: ExtrasOptions): ComposerExtras {
  const { services } = o;
  // Fresh refs for callbacks the model calls later, so it never holds a stale closure.
  const live = useRef(o);
  live.current = o;
  const attachments = useMemo(
    () => new AttachmentManager({ host: services.attachHost, project: services.project, blobs: services.blobs ?? (typeof URL !== "undefined" && typeof URL.createObjectURL === "function" ? browserBlobs : null) }),
    [services.attachHost, services.project, services.blobs],
  );
  const model = useMemo(() => {
    const actions: ComposerActions = {
      setDraft: (t) => live.current.setDraft(t),
      setMode: (id) => live.current.setMode(id),
      setModel: (p, m) => live.current.setModel(p, m),
      navigate: (t) => services.openLibraryTarget?.(t),
    };
    return new ComposerModel({ catalog: services.catalog, sources: { modes: () => MODES, models: () => live.current.models }, actions, attachments, mentions: services.mentions });
  }, [services, attachments, live]);
  useEffect(() => () => model.dispose(), [model]);

  const st = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const items = useSyncExternalStore(attachments.subscribe, attachments.getItems, attachments.getItems);
  const notices = useSyncExternalStore(attachments.subscribe, attachments.getNotices, attachments.getNotices);
  const [flash, setFlash] = useState<string | null>(null);
  const menuId = `chat-menu-${o.chatId}`;

  // The model reads the draft on every change (draft state is owned by the caller).
  useEffect(() => { model.update(o.draft); }, [model, o.draft]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.nativeEvent.isComposing) return false;
    const s = model.getState();
    if (!s.open) return false;
    if (e.key === "ArrowDown") { e.preventDefault(); model.moveDown(); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); model.moveUp(); return true; }
    if (e.key === "Enter" && !e.shiftKey || e.key === "Tab") { if (model.accept()) { e.preventDefault(); return true; } return false; }
    if (e.key === "Escape") { e.preventDefault(); model.dismiss(); return true; }
    return false;
  }, [model]);

  const prepareSend = useCallback((text: string) => {
    const call = model.builtinOf(text);
    if (call) {
      runBuiltin(call, live.current.models, {
        clearChat: () => live.current.clearChat(),
        openSection: (s) => { if (!services.openSection?.(s)) setFlash("That section is not available in this build."); },
        setModel: (p, m) => live.current.setModel(p, m),
        say: setFlash,
      });
      return null;
    }
    const p = model.consumeForSend(text);
    return { text: p.text, extra: { skills: p.skills, attachments: p.attachments } };
  }, [model, services, live]);

  const open = st.open;
  const activeId = open && st.view.items.length ? optionId(menuId, st.view.selected) : undefined;
  return {
    onKeyDown,
    textareaProps: {
      role: "combobox", "aria-autocomplete": "list", "aria-expanded": open, "aria-controls": open ? menuId : undefined, "aria-activedescendant": activeId,
    },
    menu: open ? (
      <CompletionMenu
        id={menuId} view={st.view} loading={st.loading} note={st.note} label={st.trigger?.kind === "mention" ? "Files and notes" : "Commands and skills"}
        onPick={(i) => model.accept(i)} onHover={(i) => model.select(i)}
      />
    ) : null,
    chips: (
      <ComposerChips
        skills={st.skills} attachments={items} notices={notices} message={flash ?? st.message}
        onRemoveSkill={(id) => model.removeSkill(id)} onRemoveAttachment={(id) => attachments.remove(id)}
        onDismissNotices={() => { attachments.dismissNotices(); setFlash(null); model.clearMessage(); }}
      />
    ),
    toolbar: services.attachHost ? (
      <button type="button" className="chat-btn" aria-label="Attach files" onClick={() => void attachments.pickFiles()}>Attach</button>
    ) : null,
    blockedReason: items.some((i) => i.status === "reading") ? "Reading attachments…"
      : o.busy && (items.length > 0 || st.skills.length > 0) ? "Attachments and skills send after the current turn ends." : null,
    prepareSend,
  };
}
