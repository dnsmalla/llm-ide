import { useCallback, useEffect, useState } from "react";
import { FEATURES, compiledFeatures, validateFeatures, type AppFeature } from "@llmide/screens/shell";
import { useEnv } from "../context.tsx";
import { Button, ErrorText, NeedsHost } from "../ui.tsx";

const names = (set: ReadonlySet<AppFeature>): string => FEATURES.filter((f) => set.has(f.id)).map((f) => f.label).join(", ") || "none";

/**
 * The Mac's "Build" group: what this binary was compiled with, what the profile asks for, and Apply & Rebuild.
 * A reduced build really is reduced: screens excluded at build time are absent from the frontend bundle (the Vite
 * loader map drops their chunks); the shared Node core disables their route groups at runtime from LLMIDE_FEATURES.
 */
export default function BuildSection() {
  const { host } = useEnv();
  const [stored, setStored] = useState<Set<AppFeature> | null>(null);
  const [launch, setLaunch] = useState<Set<AppFeature> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const compiled = compiledFeatures();

  const load = useCallback(() => {
    host.getFeatureProfile?.().then(
      (p) => {
        setStored(validateFeatures(p.stored.length ? p.stored : FEATURES.map((f) => f.id)));
        setLaunch(validateFeatures(p.launch.length ? p.launch : FEATURES.map((f) => f.id)));
      },
      () => undefined,
    );
  }, [host]);
  useEffect(() => {
    load();
  }, [load]);

  if (!host.getFeatureProfile) return <NeedsHost what="The build profile" />;
  if (!stored || !launch) return <p className="st-hint" role="status">Reading the build profile...</p>;

  const drift = [...stored].sort().join(",") !== [...compiled].sort().join(",");
  const removed = FEATURES.filter((f) => compiled.has(f.id) && !stored.has(f.id));
  const impossible = FEATURES.filter((f) => stored.has(f.id) && !compiled.has(f.id));

  const run = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await host.rebuildFeatures!([...stored]);
      setMessage(r.message);
      if (!r.started) setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The rebuild could not start.");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="st-stack">
      <div className="st-stack">
        <span className="st-label">Compiled into this build</span>
        <p>{names(compiled)}</p>
        <span className="st-label">Your profile</span>
        <p>{names(stored)}</p>
        {drift ? (
          <p className="st-hint">
            {removed.length ? `Applying the profile would leave out: ${removed.map((f) => f.label).join(", ")}. ` : ""}
            {impossible.length ? `${impossible.map((f) => f.label).join(", ")} cannot be turned on until a build compiles it in.` : ""}
          </p>
        ) : <p className="st-hint">The build matches your profile.</p>}
      </div>

      <div className="st-stack">
        <span className="st-label">Apply &amp; Rebuild</span>
        <p className="st-hint">
          Builds this app again from the source checkout with only your enabled features compiled in, then restarts it.
          Disabled screens are left out of the frontend bundle; the shared core disables their routes at runtime.
          A rebuild runs Rust and Vite, so it can take a few minutes, and the app restarts when it is ready.
        </p>
        <p className="st-hint">
          Manual: <code>LLMIDE_BUILD_FEATURES={[...stored].join(",")} scripts/build-desktop-mac.sh</code>
        </p>
        {host.rebuildFeatures ? (
          confirming ? (
            <div className="st-dialog" role="alertdialog" aria-label="Apply and rebuild">
              <strong>Rebuild with {stored.size} of {FEATURES.length} features?</strong>
              <p>Unsaved work in open editors is lost when the app restarts. The build needs a source checkout and the Rust/Node toolchains.</p>
              <div className="st-row">
                <Button tone="primary" disabled={busy} onClick={() => void run()}>{busy ? "Starting..." : "Start build"}</Button>
                <Button disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="st-row">
              <Button tone="primary" disabled={busy} onClick={() => setConfirming(true)}>Apply &amp; Rebuild (remove disabled code)</Button>
              <Button disabled={busy} onClick={load}>Reload</Button>
            </div>
          )
        ) : (
          <NeedsHost what="Rebuilding from inside the app" />
        )}
        {message ? <p className="st-ok" role="status">{message}</p> : null}
        <ErrorText text={error} />
      </div>

      <div className="st-stack">
        <span className="st-label">What changes per feature</span>
        <ul>
          {FEATURES.filter((f) => f.excludable).map((f) => (
            <li key={f.id}><strong>{f.label}</strong>: {f.removes}.</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
