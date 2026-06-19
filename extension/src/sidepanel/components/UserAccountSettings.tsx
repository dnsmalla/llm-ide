// User account panel — shows the LLM IDE server account this
// extension is signed in to (the email/password the user registered
// with on 127.0.0.1:3456), and lets them change their password or
// sign out.  This is distinct from the Bot account panel below,
// which is the Google account the bot uses to JOIN meetings.
//
// GET  /auth/me            → email, role, displayName, timestamps
// POST /auth/me/password   → currentPassword + newPassword
// Sign out                 → useSession().logout()

import React, { useEffect, useState } from 'react';
import { authFetch, getServerUrl } from '../../lib/config';
import { useSession } from '../hooks/useSession';

interface Me {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  createdAt: number;
  lastLoginAt: number | null;
}

function fmtDate(ts: number | null | undefined): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '—';
  }
}

export default function UserAccountSettings(): JSX.Element {
  const { logout } = useSession();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Change-password form
  const [showPwForm, setShowPwForm] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwStatus, setPwStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = await getServerUrl();
        const r = await authFetch(`${url}/auth/me`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j: Me = await r.json();
        if (!cancelled) setMe(j);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'failed to load');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function changePassword() {
    setPwStatus(null);
    if (!currentPw || !newPw) {
      setPwStatus('Both fields required.');
      return;
    }
    if (newPw !== confirmPw) {
      setPwStatus('New passwords do not match.');
      return;
    }
    if (newPw.length < 8) {
      setPwStatus('New password must be at least 8 characters.');
      return;
    }
    setPwBusy(true);
    try {
      const url = await getServerUrl();
      const r = await authFetch(`${url}/auth/me/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        throw new Error(body?.error?.message || `HTTP ${r.status}`);
      }
      setPwStatus('Password changed.');
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
      setShowPwForm(false);
    } catch (err) {
      setPwStatus(err instanceof Error ? err.message : 'Change failed.');
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <>
      <h3 className="settings-heading">User account</h3>
      <p className="settings-hint">
        The LLM IDE account you signed in to your local server with. Stored on <code>127.0.0.1:3456</code>; never leaves
        your machine.
      </p>

      {error && <p className="settings-hint settings-hint--error">{error}</p>}

      {me && (
        <dl className="diagnostics-grid">
          <dt>Email</dt>
          <dd>{me.email}</dd>
          <dt>Display name</dt>
          <dd>{me.displayName || <em>(none)</em>}</dd>
          <dt>Role</dt>
          <dd>{me.role}</dd>
          <dt>Member since</dt>
          <dd>{fmtDate(me.createdAt)}</dd>
          <dt>Last login</dt>
          <dd>{fmtDate(me.lastLoginAt)}</dd>
        </dl>
      )}

      {!showPwForm ? (
        <div className="settings-row settings-row-actions">
          <button
            className="btn btn-sm"
            onClick={() => {
              setShowPwForm(true);
              setPwStatus(null);
            }}
          >
            Change password
          </button>
          <button
            className="btn btn-sm btn-quiet"
            onClick={() => {
              void logout();
            }}
          >
            Sign out
          </button>
          {pwStatus && <span className="settings-hint">{pwStatus}</span>}
        </div>
      ) : (
        <>
          <div className="settings-row settings-row-stack">
            <label className="settings-label" htmlFor="user-current-pw">
              Current password
            </label>
            <input
              id="user-current-pw"
              className="settings-input"
              type="password"
              autoComplete="current-password"
              value={currentPw}
              onChange={(e) => setCurrentPw(e.target.value)}
              disabled={pwBusy}
            />
          </div>
          <div className="settings-row settings-row-stack">
            <label className="settings-label" htmlFor="user-new-pw">
              New password
            </label>
            <input
              id="user-new-pw"
              className="settings-input"
              type="password"
              autoComplete="new-password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              disabled={pwBusy}
            />
          </div>
          <div className="settings-row settings-row-stack">
            <label className="settings-label" htmlFor="user-confirm-pw">
              Confirm new password
            </label>
            <input
              id="user-confirm-pw"
              className="settings-input"
              type="password"
              autoComplete="new-password"
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              disabled={pwBusy}
            />
          </div>
          <div className="settings-row settings-row-actions">
            <button className="btn btn-sm" onClick={changePassword} disabled={pwBusy}>
              {pwBusy ? 'Saving…' : 'Save password'}
            </button>
            <button
              className="btn btn-sm btn-quiet"
              onClick={() => {
                setShowPwForm(false);
                setCurrentPw('');
                setNewPw('');
                setConfirmPw('');
                setPwStatus(null);
              }}
              disabled={pwBusy}
            >
              Cancel
            </button>
            {pwStatus && <span className="settings-hint">{pwStatus}</span>}
          </div>
        </>
      )}
    </>
  );
}
