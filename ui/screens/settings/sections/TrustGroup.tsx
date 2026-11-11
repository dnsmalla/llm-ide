import ToolPermissionsSection from "./ToolPermissionsSection.tsx";
import { Allowlist, TrustedFolders } from "./ExtensionsTrustSection.tsx";

/** One security surface: what may run, where installs may come from, and the rules the user saved. */
export default function TrustGroup() {
  return (
    <div className="st-stack">
      <div className="st-stack"><span className="st-label">Tools</span><ToolPermissionsSection /></div>
      <div className="st-stack"><span className="st-label">Folder trust</span><TrustedFolders /></div>
      <div className="st-stack"><span className="st-label">Extension sources</span><Allowlist /></div>
    </div>
  );
}
