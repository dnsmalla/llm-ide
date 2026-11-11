import { WorkspaceSection } from "./SimpleSections.tsx";
import { FeatureProfileSection } from "./FeatureProfileSection.tsx";
import BuildSection from "./BuildSection.tsx";
import { PartialNote } from "./NoticeSections.tsx";

/** One workspace concern: the open project, its screen profile, and (for source checkouts) rebuilding with it. */
export default function WorkspaceGroup() {
  return (
    <div className="st-stack">
      <WorkspaceSection />
      <div className="st-stack"><span className="st-label">Features</span><FeatureProfileSection /></div>
      <div className="st-stack"><span className="st-label">Build</span><BuildSection /></div>
      <PartialNote id="workspace" />
    </div>
  );
}
