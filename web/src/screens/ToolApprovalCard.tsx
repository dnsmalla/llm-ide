import { Badge, Banner, Button } from "../ui/index.ts";
import type { WebApproval } from "../chat/store.ts";

type ToolApproval = Extract<WebApproval, { kind: "tool" }>;

export function ToolApprovalCard({ approval: a, onDecide }: { approval: ToolApproval; onDecide: (decision: "allow_once" | "deny") => void }) {
  return (
    <section className="appr-card web-tool-card" role="group" aria-label="The assistant wants to use a tool">
      <div className="web-tool-head"><Badge tone="warning" dot>Needs your OK</Badge><h3 className="appr-title">{a.toolName}</h3></div>
      {a.filePath && <p className="web-path">{a.filePath}</p>}
      {a.summary && <pre className="web-summary">{a.summary}</pre>}
      {a.truncated && <p className="chat-muted">(shortened)</p>}
      {a.error && <Banner tone="error">{a.error}</Banner>}
      <p className="chat-muted">Rules that skip this question are made and revoked on the desktop (Settings, Tool permissions).</p>
      <div className="web-actions">
        <Button variant="primary" disabled={a.submitting} onClick={() => onDecide("allow_once")}>Allow once</Button>
        <Button variant="secondary" disabled={a.submitting} onClick={() => onDecide("deny")}>Deny</Button>
      </div>
    </section>
  );
}
