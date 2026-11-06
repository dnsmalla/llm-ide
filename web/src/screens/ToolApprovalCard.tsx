import { StatusBanner } from "@llmide/ui-kit";
import type { WebApproval } from "../chat/store.ts";

type ToolApproval = Extract<WebApproval, { kind: "tool" }>;

export function ToolApprovalCard({ approval: a, onDecide }: { approval: ToolApproval; onDecide: (decision: "allow_once" | "deny") => void }) {
  return (
    <section className="appr-card" role="group" aria-label="The assistant wants to use a tool">
      <h3 className="appr-title">{a.toolName}</h3>
      {a.filePath && <p className="web-path">{a.filePath}</p>}
      {a.summary && <pre className="web-summary">{a.summary}</pre>}
      {a.truncated && <p className="chat-muted">(shortened)</p>}
      {a.error && <StatusBanner severity="error" message={a.error} />}
      <p className="chat-muted">Rules that skip this question are made and revoked on the desktop (Settings, Tool permissions).</p>
      <div className="web-actions">
        <button type="button" disabled={a.submitting} onClick={() => onDecide("allow_once")}>Allow once</button>
        <button type="button" disabled={a.submitting} onClick={() => onDecide("deny")}>Deny</button>
      </div>
    </section>
  );
}
