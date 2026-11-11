import { Allowlist, TrustedFolders } from "./ExtensionsTrustSection.tsx";

/** Security settings that answer the same question: what may run, and where installs may come from. */
export default function TrustGroup() {
  return (
    <div className="st-stack">
      <TrustedFolders />
      <Allowlist />
    </div>
  );
}
