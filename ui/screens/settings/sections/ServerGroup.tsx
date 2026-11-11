import ServerSection from "./ServerSection.tsx";
import AgentSdkSection from "./AgentSdkSection.tsx";

/** The core and its agent engine are one backend concern: keep the SDK version beside the server controls. */
export default function ServerGroup() {
  return (
    <div className="st-stack">
      <ServerSection />
      <div className="st-stack">
        <span className="st-label">Agent engine</span>
        <AgentSdkSection />
      </div>
    </div>
  );
}
