// Settings panel for the meeting-agent persona — name + prompt
// suffix.  No vendor key, no secrets; just preference.
//
// On first mount we GET /kb/agent/persona; the form binds to local
// state.  Save → PUT /kb/agent/persona.  Reset clears the stored
// flag so the agent falls back to built-in defaults.

import React, { useEffect, useState } from 'react';
import { authFetch, getServerUrl } from '../../lib/config';
import AgentStatsBadge from './AgentStatsBadge';

interface Persona {
  name: string | null;
  promptSuffix: string | null;
}

export default function AgentPersonaSettings(): JSX.Element {
  const [name, setName] = useState('');
  const [promptSuffix, setPromptSuffix] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Load on mount.  Treat any error as "no persona stored" — this
  // tab shouldn't refuse to render just because the network blipped.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = await getServerUrl();
        const r = await authFetch(`${url}/kb/agent/persona`);
        if (r.ok) {
          const j = await r.json();
          if (!cancelled && j.persona) {
            setName(j.persona.name ?? '');
            setPromptSuffix(j.persona.promptSuffix ?? '');
          }
        }
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      const url = await getServerUrl();
      const r = await authFetch(`${url}/kb/agent/persona`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, promptSuffix }),
      });
      if (!r.ok) throw new Error(`PUT failed: ${r.status}`);
      const j: { persona: Persona | null } = await r.json();
      if (!j.persona) {
        setStatus('Reset to defaults.');
      } else {
        setStatus('Saved.');
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setName('');
    setPromptSuffix('');
    setBusy(true);
    try {
      const url = await getServerUrl();
      await authFetch(`${url}/kb/agent/persona`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      setStatus('Reset to defaults.');
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return <p className="settings-hint">Loading agent settings…</p>;
  }

  return (
    <>
      <h3 className="settings-heading">Agent persona</h3>
      <AgentStatsBadge />
      <p className="settings-hint">
        Customize how the meeting agent introduces itself and what it watches for. Both fields are optional — leave
        blank for the built-in defaults.
      </p>
      <div className="settings-row">
        <label className="settings-label" htmlFor="agent-persona-name">
          Name
        </label>
        <input
          id="agent-persona-name"
          className="settings-input"
          type="text"
          maxLength={200}
          placeholder="Agent"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="settings-row settings-row-stack">
        <label className="settings-label" htmlFor="agent-persona-suffix">
          Voice / focus
        </label>
        <textarea
          id="agent-persona-suffix"
          className="settings-textarea"
          rows={3}
          maxLength={8000}
          placeholder="Be terse. Only ask about risks and missed assumptions."
          value={promptSuffix}
          onChange={(e) => setPromptSuffix(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="settings-row settings-row-actions">
        <button className="btn btn-sm" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className="btn btn-sm btn-quiet" onClick={reset} disabled={busy}>
          Reset
        </button>
        {status && <span className="settings-hint">{status}</span>}
      </div>
    </>
  );
}
