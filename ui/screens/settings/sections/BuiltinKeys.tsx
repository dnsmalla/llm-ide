// The Mac's built-in key rows (Settings -> Providers): Anthropic, Jev and SerpAPI. Write-only: the typed key goes to
// the core once and the field is emptied at once. The page shows "Saved" or "Not set" from the status names only.
import { useCallback, useEffect, useRef, useState } from "react";
import { useEnv, useRefreshOnFocus } from "../context.tsx";
import { call } from "../core-api.ts";
import { decodeHealth } from "../decoders.ts";
import { describeError } from "../errors.ts";
import {
  KeyError,
  clearBuiltinKey,
  keyStateLabel,
  loadStoredKeyNames,
  saveBuiltinKey,
  visibleBuiltinKeys,
  type BuiltinKey,
} from "../builtin-keys-model.ts";
import { SecretField } from "../secret-field.ts";
import { Button, ErrorText, SecretInput } from "../ui.tsx";

export interface KeyMessage {
  ok: boolean;
  text: string;
}

export const errorText = (e: unknown): string => (e instanceof KeyError ? e.message : describeError(e));

/** Focuses Cancel when the confirmation opens, so Enter does not clear by accident. */
function ClearConfirm({ row, busy, onCancel, onClear }: { row: BuiltinKey; busy: boolean; onCancel: () => void; onClear: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div className="st-dialog" role="alertdialog" aria-label={`Clear the stored ${row.label} key`}>
      <strong>Clear the stored {row.label} key?</strong>
      <p className="st-hint">Anything that needs this key stops working until you paste a key again. A cleared key cannot be recovered.</p>
      <div className="st-row">
        <button ref={cancel} type="button" className="st-btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <Button tone="danger" disabled={busy} onClick={onClear}>Clear key</Button>
      </div>
    </div>
  );
}

/** One key row. Presentational: the parent owns the field, the busy flag and the confirmation. */
export function BuiltinKeyRow({ row, stored, resetKey, field, busy, message, confirming, onSave, onAskClear, onCancelClear, onClear }: {
  row: BuiltinKey;
  stored: boolean | null;
  resetKey: number;
  field: SecretField;
  busy: boolean;
  message: KeyMessage | null;
  confirming: boolean;
  onSave: () => void;
  onAskClear: () => void;
  onCancelClear: () => void;
  onClear: () => void;
}) {
  return (
    <div className="st-stack" data-builtin-key={row.id}>
      <div className="st-row">
        <strong className="st-grow">{row.label}</strong>
        <span className="st-status" data-tone={stored ? "ok" : undefined}>{keyStateLabel(stored)}</span>
      </div>
      <p className="st-hint">{row.hint}</p>
      <SecretInput
        label={`API key for ${row.label}`}
        field={field}
        resetKey={resetKey}
        placeholder={row.placeholder}
        hint={stored ? "Enter a new key to replace the stored one." : undefined}
      />
      <div className="st-row">
        <Button label={`Save key for ${row.label}`} disabled={busy} onClick={onSave}>{row.verifyAs ? "Save & verify" : "Save key"}</Button>
        {stored ? (
          <Button label={`Clear the key for ${row.label}`} disabled={busy || confirming} onClick={onAskClear}>Clear key…</Button>
        ) : null}
      </div>
      {confirming ? <ClearConfirm row={row} busy={busy} onCancel={onCancelClear} onClear={onClear} /> : null}
      {message ? (message.ok ? <p className="st-hint" role="status">{message.text}</p> : <ErrorText text={message.text} />) : null}
    </div>
  );
}

export function BuiltinKeys() {
  const { client } = useEnv();
  const [names, setNames] = useState<Set<string> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [apiVersion, setApiVersion] = useState<number | null>(null);
  const [messages, setMessages] = useState<Record<string, KeyMessage>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [resets, setResets] = useState<Record<string, number>>({});
  const fields = useRef(new Map<string, SecretField>());
  const inFlight = useRef(false);

  const fieldFor = (id: string): SecretField => {
    let f = fields.current.get(id);
    if (!f) {
      f = new SecretField();
      fields.current.set(id, f);
    }
    return f;
  };

  // Drop any typed draft when the page goes away.
  useEffect(() => () => { for (const f of fields.current.values()) f.clear(); }, []);

  const loadNames = useCallback(() => {
    loadStoredKeyNames(client).then(
      (s) => { setNames(s); setLoadError(null); },
      (e) => setLoadError(errorText(e)),
    );
  }, [client]);
  useRefreshOnFocus(loadNames);

  useEffect(() => {
    call(client, "GET", "/health").then(
      (b) => setApiVersion(decodeHealth(b).apiVersion),
      () => setApiVersion(null),
    );
  }, [client]);

  // Runs one key action at a time; a second click while one runs is ignored.
  const run = async (row: BuiltinKey, action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusyId(row.id);
    try {
      await action();
    } finally {
      inFlight.current = false;
      setBusyId(null);
      loadNames();
    }
  };

  const save = (row: BuiltinKey) => {
    const field = fieldFor(row.id);
    if (inFlight.current) return;
    // The request takes the typed value synchronously; the box is emptied right after, even on refusal.
    const pending = saveBuiltinKey(client, row, field);
    setResets((r) => ({ ...r, [row.id]: (r[row.id] ?? 0) + 1 }));
    void run(row, async () => {
      try {
        const text = await pending;
        setMessages((m) => ({ ...m, [row.id]: { ok: true, text } }));
      } catch (e) {
        setMessages((m) => ({ ...m, [row.id]: { ok: false, text: errorText(e) } }));
      }
    });
  };

  const clear = (row: BuiltinKey) => {
    void run(row, async () => {
      try {
        await clearBuiltinKey(client, row);
        setConfirmingId(null);
        setMessages((m) => ({ ...m, [row.id]: { ok: true, text: "Key cleared." } }));
      } catch (e) {
        setMessages((m) => ({ ...m, [row.id]: { ok: false, text: errorText(e) } }));
      }
    });
  };

  return (
    <div className="st-note" role="group" aria-label="Built-in API keys">
      <span className="st-label">API keys</span>
      <p className="st-hint">Keys are write-only. Once saved, this page shows only Saved or Not set, and a new key replaces the stored one.</p>
      {loadError ? <ErrorText text={loadError} /> : null}
      {visibleBuiltinKeys(apiVersion).map((row) => (
        <BuiltinKeyRow
          key={row.id}
          row={row}
          stored={names === null ? null : names.has(row.vaultKey)}
          resetKey={resets[row.id] ?? 0}
          field={fieldFor(row.id)}
          busy={busyId === row.id}
          message={messages[row.id] ?? null}
          confirming={confirmingId === row.id}
          onSave={() => save(row)}
          onAskClear={() => setConfirmingId(row.id)}
          onCancelClear={() => setConfirmingId(null)}
          onClear={() => clear(row)}
        />
      ))}
    </div>
  );
}
