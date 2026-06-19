import React, { useState } from 'react';
import HelpPanel from './HelpPanel';

interface Props {
  onLogin: (email: string, password: string) => Promise<boolean>;
  onRegister: (email: string, password: string, displayName?: string) => Promise<boolean>;
  busy: boolean;
  error: string | null;
  registrationOpen: boolean;
}

export default function LoginView({ onLogin, onRegister, busy, error, registrationOpen }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');

  const [fieldError, setFieldError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setFieldError(null);
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setFieldError('Please enter your email address.');
      return;
    }
    if (!password) {
      setFieldError('Please enter your password.');
      return;
    }
    if (mode === 'register' && password.length < 10) {
      setFieldError('Password must be at least 10 characters.');
      return;
    }
    if (mode === 'login') {
      await onLogin(trimmedEmail, password);
    } else {
      await onRegister(trimmedEmail, password, displayName.trim() || undefined);
    }
  };

  return (
    <div className="login-view">
      <header className="login-header">
        <h1>LLM IDE</h1>
        <p>{mode === 'login' ? 'Sign in to continue' : 'Create an account'}</p>
      </header>

      <form onSubmit={submit} className="login-form">
        {mode === 'register' && (
          <label className="login-field">
            <span>Display name (optional)</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Alice"
              maxLength={80}
            />
          </label>
        )}
        <label className="login-field">
          <span>Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            spellCheck={false}
          />
        </label>
        <label className="login-field">
          <span>Password</span>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === 'register' ? 'At least 10 characters' : ''}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={mode === 'register' ? 10 : undefined}
          />
        </label>

        {(error || fieldError) && (
          <div className="error-message" role="alert">
            {fieldError || error}
          </div>
        )}

        <button type="submit" className="btn btn-generate" disabled={busy || !email || !password}>
          {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>

        {registrationOpen ? (
          <button
            type="button"
            className="login-switch-mode"
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
            disabled={busy}
          >
            {mode === 'login' ? 'Need an account? Register' : 'Already have an account? Sign in'}
          </button>
        ) : mode === 'register' ? (
          <p className="login-hint">Registration is closed on this server. Ask your admin for an account.</p>
        ) : null}
      </form>

      <footer className="login-footer">
        <p>
          Server:{' '}
          <code>
            {(typeof window !== 'undefined' && (window as { __llmideUrl?: string }).__llmideUrl) ||
              'http://localhost:3456'}
          </code>
        </p>
        <button
          type="button"
          className="login-help-link"
          onClick={() => setShowHelp(true)}
          aria-label="Open help guide"
        >
          Need help getting started?
        </button>
      </footer>

      {showHelp && <HelpPanel onClose={() => setShowHelp(false)} />}
    </div>
  );
}
