// Bundle entry for the integration harness: only the framework-free modules, wired exactly as the app wires them.
export { createCoreClient, CoreError } from "../../core.ts";
export { createChatBinding } from "../../chat-binding.ts";
export { createShellBus, relativeToProject, safeRelativePath } from "../../bus.ts";
export { createSettingsEnv, settingsClientFrom } from "../../settings-adapter.ts";
export { coreTransportFrom } from "../../../chat/adapter.ts";
export { ChatController } from "../../../chat/controller.ts";
export { HttpChatStore, MemoryChatStore } from "../../../chat/store.ts";
export { TauriChatStore, APPLE_EPOCH_OFFSET, isDeclined, isPendingCorrupt, needsTruncateConfirm, unreadableNotice, PENDING_CORRUPT_NOTICE } from "../../../chat/tauri-store.ts";
export { fileArgOf } from "../../../chat/MessageView.tsx";
export { ProvidersApi, ProvidersModel } from "../../../settings/providers-model.ts";
export { makeSearchRun } from "../../../library/search.ts";
export { searchCoreFrom, indexCoreFrom } from "../../../library/core-adapter.ts";
export { rebuildIndex, IDLE_REBUILD } from "../../../library/index-rebuild.ts";
export { recordFromEntry, applyHead } from "../../../library/notes-model.ts";
