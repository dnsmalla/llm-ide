// The "Easy setup" section of the Google pane: Calendar by secret iCal address, Drive by the Drive for desktop
// folder, plus a slot for the Gmail app-password card (built from the Email pane's own pieces in SourcePanes.tsx,
// so it reuses the same routes and write-only secret field). No Google Cloud project and no OAuth here.
//
// Rules: the iCal address is a secret (write-only password input, cleared when sent, never echoed; only the first
// characters of the calendar id are shown afterwards); every string from the core or the file system is text.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { PaneEnv } from "../SourcePanes";
import { addRepo, indexRepo, listRepos, removeRepo, type RepoEntry } from "../source-actions.ts";
import { mapThrown, sourceErrorText, type SourceError } from "../source-core.ts";
import { icalApiFrom, type IcalApi } from "./ical-api.ts";
import { IcalCard } from "./IcalCard";
import { GuideCard } from "./GuideCard";
import * as E from "./easy.ts";
import { Check } from "./shared";

// ---- drive -----------------------------------------------------------------------------------

function sourceErrorMessage(e: SourceError): string {
  return `${sourceErrorText(e.code, "this folder")}${e.serverCode ? ` (${e.serverCode})` : ""}`;
}

export function DriveCard({ env }: { env: PaneEnv }): ReactNode {
  const [repos, setRepos] = useState<RepoEntry[] | null>(null);
  const [picked, setPicked] = useState<{ path: string; name: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [err, setErr] = useState<SourceError | null>(null);
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    listRepos(env.core, ac.signal).then(
      (r) => setRepos(r),
      () => !ac.signal.aborted && setRepos([]),
    );
    return () => ac.abort();
  }, [env.core, n]);
  const state = E.driveCardState(picked, env.pickFolder !== null, confirmed);
  const mine = useMemo(() => (repos ? E.driveFolders(repos) : []), [repos]);
  const run = async (fn: (s: AbortSignal) => Promise<void>): Promise<void> => {
    setBusy(true);
    setErr(null);
    const ac = new AbortController();
    try {
      await fn(ac.signal);
    } catch (e) {
      const m = mapThrown(e, ac.signal);
      if (m.code !== "cancelled") setErr(m);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="lib-pane-section" aria-label="Easy setup: Google Drive">
      <h3>Google Drive</h3>
      <GuideCard guide={E.DRIVE_GUIDE} notes={E.DRIVE_NOTES} />
      {state === "no_picker" ? (
        <StatusBanner severity="info" message="Choosing a folder is only possible inside the desktop app." />
      ) : (
        <div className="lib-form">
          <div className="lib-editor-bar">
            <button
              type="button"
              className="lib-btn"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const p = await env.pickFolder!();
                  setPicked(p);
                  setConfirmed(false);
                })
              }
            >
              Choose your Drive folder…
            </button>
            {picked && <span className="lib-muted lib-path">{E.driveFolderLabel(picked.path)}</span>}
          </div>
          {state === "refused" && <StatusBanner severity="warning" message="That folder is too broad (a home folder or a drive root). Choose your Google Drive folder, or a folder inside it." />}
          {state === "needs_confirm" && (
            <Check checked={confirmed} onChange={setConfirmed}>
              This does not look like a Drive for desktop folder. It is my Google Drive folder; add it anyway.
            </Check>
          )}
          <button
            type="button"
            className="lib-btn lib-btn-primary"
            disabled={busy || state !== "ready" || !picked}
            onClick={() =>
              void run(async (signal) => {
                if (!picked) return;
                setInfo("Adding the folder…");
                await addRepo(env.core, picked.path, E.driveFolderLabel(picked.path), signal);
                const res = await indexRepo(env.core, picked.path, signal);
                const files = Object.values(res.counts).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
                setInfo(`Added and indexed ${E.driveFolderLabel(picked.path)} (${files.toLocaleString()} items).`);
                setPicked(null);
                setN((x) => x + 1);
              })
            }
          >
            Add and index this folder
          </button>
        </div>
      )}
      {mine.length > 0 && (
        <ul className="lib-items" aria-label="Drive folders">
          {mine.map((r) => (
            <li key={r.path}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong>{E.driveFolderLabel(r.path)}</strong>
              </span>
              <button
                type="button"
                className="lib-btn"
                disabled={busy}
                onClick={() =>
                  void run(async (signal) => {
                    setInfo(`Indexing ${E.driveFolderLabel(r.path)}…`);
                    await indexRepo(env.core, r.path, signal);
                    setInfo(`Indexed ${E.driveFolderLabel(r.path)}.`);
                  })
                }
              >
                Index
              </button>
              <button
                type="button"
                className="lib-btn lib-btn-danger"
                disabled={busy}
                onClick={() =>
                  void run(async (signal) => {
                    await removeRepo(env.core, r.path, signal);
                    setN((x) => x + 1);
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {info && <StatusBanner severity="info" message={info} onDismiss={() => setInfo(null)} />}
      {err && <StatusBanner severity="error" message={sourceErrorMessage(err)} onDismiss={() => setErr(null)} />}
    </section>
  );
}

// ---- container -------------------------------------------------------------------------------

export function EasySetup({ env, gmailCard, ical }: { env: PaneEnv; gmailCard: ReactNode; ical?: IcalApi }): ReactNode {
  const api = useMemo(() => ical ?? icalApiFrom(env.core), [ical, env.core]);
  return (
    <section className="lib-pane-section" aria-label="Easy setup">
      <h3>Easy setup</h3>
      <p className="lib-muted">{E.EASY_INTRO}</p>
      {gmailCard}
      <IcalCard api={api} />
      <DriveCard env={env} />
    </section>
  );
}
