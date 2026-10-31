import { WorkspaceSection } from "./SimpleSections.tsx";
import { FeatureProfileSection } from "./FeatureProfileSection.tsx";
import { PartialNote } from "./NoticeSections.tsx";

/** The Mac's "Workspace" group: the open project, notes folder, Home page, and the feature profile. */
export default function WorkspaceGroup() {
  return (
    <div className="st-stack">
      <WorkspaceSection />
      <div className="st-stack"><span className="st-label">Features</span><FeatureProfileSection /></div>
      <PartialNote id="workspace" />
    </div>
  );
}
