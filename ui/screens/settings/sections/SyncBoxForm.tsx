// Settings → Phone and web sync → Box: the user's own Box app (client ID + secret) and a one-time consent in the system
// browser (SP6 D1). The secret field is write-only and cleared after Connect; the core never returns it.
import { useState, type ReactNode } from "react";
import { host as shellHost, invokeHost } from "@llmide/screens/shell";
import { useEnv } from "../context.tsx";
import { Button } from "../ui.tsx";
import { BOX_DESKTOP_REDIRECT, boxConnectFailureText, startBoxConnect, testSync, waitBoxConnect } from "../sync-model.ts";

export default function SyncBoxForm({ folder, switching, run, onConnect }: { folder: string; switching: boolean; run: (fn: () => Promise<unknown>, ok?: string) => Promise<void>; onConnect: (fn: () => Promise<void>) => void }): ReactNode {
  const { client } = useEnv();
  const [form, setForm] = useState({ clientId: "", clientSecret: "", folder });
  const [link, setLink] = useState<string | null>(null);
  const connect = () => run(async () => {
    const { authorizeUrl } = await startBoxConnect(client, { clientId: form.clientId.trim(), clientSecret: form.clientSecret.trim(), folder: form.folder.trim() || "llmide-sync" });
    setForm((f) => ({ ...f, clientSecret: "" }));
    const opened = shellHost.isAvailable() ? (await invokeHost<boolean>("open_external_url", { url: authorizeUrl })) === true : false;
    setLink(opened ? null : authorizeUrl);
    const r = await waitBoxConnect(client);
    setLink(null);
    if (r.phase !== "done") throw new Error(r.phase === "timeout" ? "Box sign-in timed out. Start again." : boxConnectFailureText(r.code));
    await testSync(client);
  }, "Box is connected and the test file round-tripped.");
  return (
    <div className="st-stack">
      <div className="st-stack" role="note">
        <p className="st-hint"><strong>Use a Box account kept only for LLM-IDE</strong> (a free Box account is enough). Box has no single-folder access, so phones and browsers you add get read and write access to that <em>whole</em> Box account. The folder only ever holds encrypted files.</p>
        <p className="st-hint">In the Box developer console, create a <strong>Custom App</strong> with <strong>User Authentication (OAuth 2.0)</strong>. Under Configuration: scope "Read and write all files and folders stored in Box"; redirect URIs <code>{BOX_DESKTOP_REDIRECT}</code>, <code>https://&lt;your web app&gt;/box-callback.html</code> and <code>llmide-box://oauth</code>; CORS domain: your web app's address.</p>
        <p className="st-hint">The client secret stays in this computer's encrypted vault. Phones and browsers receive the client ID and secret inside the pairing code.</p>
        {switching && <p className="st-hint"><strong>Switching storage removes every paired phone and browser</strong> and deletes the encrypted files in the old storage. Pair them again afterwards.</p>}
      </div>
      <label className="st-field">Box client ID
        <input className="st-input" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} aria-label="Box client ID" autoComplete="off" spellCheck={false} />
      </label>
      <label className="st-field">Box client secret
        <input className="st-input" type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} aria-label="Box client secret" autoComplete="new-password" />
      </label>
      <label className="st-field">Folder name
        <input className="st-input" value={form.folder} onChange={(e) => setForm({ ...form, folder: e.target.value })} aria-label="Box folder name" spellCheck={false} />
      </label>
      <div className="st-row"><Button onClick={() => onConnect(connect)} disabled={!form.clientId.trim() || !form.clientSecret.trim()}>Connect Box</Button></div>
      {link && <p className="st-hint" aria-live="polite">Open this address in your browser to sign in to Box: <code>{link}</code></p>}
    </div>
  );
}
