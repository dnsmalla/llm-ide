// Bundle entry for the first-run test: the framework-free modules, wired as the shell wires them.
export { createCoreClient } from "../../core.ts";
export { createProjectStore } from "../../project-store.ts";
export { landingFor, readHome } from "../../landing.ts";
export { initialNav, navReducer } from "../../sections.ts";
export { computeGate } from "../../gate.ts";
export { deriveStatusView } from "../../status-view.ts";
export { normalizeCoreStatus } from "../../host.ts";
export { registerNewProject, validateProjectName } from "../../../welcome/model.ts";
export { projectIdFor } from "../../../docgen/docs-api.ts";
export { coreTransportFrom } from "../../../chat/adapter.ts";
export { ChatController } from "../../../chat/controller.ts";
export { HttpChatStore } from "../../../chat/store.ts";
