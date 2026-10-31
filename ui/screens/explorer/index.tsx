// Public surface of the Explorer screen (S-C). The shell lazy-loads the default export.
import "@llmide/ui-kit/styles.css";
import "./explorer.css";

export { default, ExplorerScreen, type ExplorerDeps } from "./ExplorerScreen";
export { ExplorerController, type ExplorerSnapshot } from "./controller";
export { createHostFs, type FsApi } from "./fs";
