// A connected remote workspace. Hosts are added and opened from the Welcome page.
import type { SectionProps } from "../shell/sections";
import { shellBus } from "../shell/bus";
import { RemoteWorkspace } from "./RemoteWorkspace.tsx";
import { getRemote } from "./session.ts";
import "./remote.css";

export default function RemoteScreen(_: SectionProps) {
  if (getRemote()) return <RemoteWorkspace />;
  return (
    <div className="remote-connect">
      <h2>No remote workspace is open</h2>
      <p>Add or open a remote host from the Welcome page.</p>
      <button type="button" onClick={() => shellBus.publish({ type: "goto-section", section: "welcome" })}>Go to Welcome</button>
    </div>
  );
}
