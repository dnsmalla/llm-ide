import { useState } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { call } from "../core-api.ts";
import { decodeHealth, decodeMe, type Health, type Me } from "../decoders.ts";
import type { DiagnosticsInfo } from "../host.ts";
import { describeError } from "../errors.ts";
import { buildDiagnostics, coreTrustLabel, coreTrustTone } from "../misc-model.ts";
import { useEnv, useRefreshOnFocus } from "../context.tsx";
import { Button, ErrorText } from "../ui.tsx";

export default function AboutSection() {
  const { client, host } = useEnv();
  const [info, setInfo] = useState<DiagnosticsInfo | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useRefreshOnFocus(() => {
    host.diagnostics().then(setInfo, (e) => setError(describeError(e)));
    call(client, "GET", "/health").then((b) => setHealth(decodeHealth(b)), () => setHealth(null));
    call(client, "GET", "/auth/me").then((b) => setMe(decodeMe(b)), () => setMe(null));
  });

  const copy = async () => {
    if (!info) return;
    try {
      await host.copyText(buildDiagnostics(info, health, me));
      setCopied(true);
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <div className="st-stack">
      <ErrorText text={error} />
      {info ? (
        <>
          <dl className="st-stack">
            <div><dt className="st-label">App version</dt><dd>{info.appVersion}</dd></div>
            <div><dt className="st-label">Platform</dt><dd>{info.platform}</dd></div>
            <div><dt className="st-label">Backend</dt><dd>{health ? `${health.status}, API ${health.apiVersion}` : "No answer"}</dd></div>
            <div><dt className="st-label">Core log</dt><dd>{info.coreLogPath ?? "Not available"}</dd></div>
          </dl>
          <StatusBanner severity={coreTrustTone(info.coreTrust) === "ok" ? "info" : "warning"} message={coreTrustLabel(info.coreTrust)} />
          <div className="st-row">
            <Button onClick={() => void copy()}>Copy diagnostics</Button>
            {copied ? <span className="st-ok" role="status">Copied. It holds versions and states only, no keys or tokens.</span> : null}
          </div>
        </>
      ) : <p className="st-hint" role="status">Loading...</p>}
    </div>
  );
}
