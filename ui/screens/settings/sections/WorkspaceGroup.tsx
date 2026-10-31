import { FeaturesSection, WorkspaceSection } from "./SimpleSections.tsx";
import { PartialNote } from "./NoticeSections.tsx";

/** The Mac's "Workspace" group: the open project and notes folder, and the core's feature set. */
export default function WorkspaceGroup() {
  return (
    <div className="st-stack">
      <WorkspaceSection />
      <div className="st-stack"><span className="st-label">Features</span><FeaturesSection /></div>
      <PartialNote id="workspace" />
    </div>
  );
}
