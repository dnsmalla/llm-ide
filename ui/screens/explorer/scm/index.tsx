// Public surface of the Source Control panel. S-H mounts the default export in the Explorer panel switcher:
//   <ScmPanel projectRoot={root} onOpenFile={(p) => ...} onOpenDiff={(p, staged) => ...} />
import "@llmide/ui-kit/styles.css";
import "./scm.css";
import { ScmPanel } from "./ScmPanel";

export { ScmPanel, type ScmPanelProps } from "./ScmPanel";
export { ScmController, type ScmSnapshot } from "./controller";
export { createHostScm, type ScmApi } from "./api";
export default ScmPanel;
