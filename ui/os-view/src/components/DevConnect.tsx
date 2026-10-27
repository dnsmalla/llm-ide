import { useState, type FormEvent } from 'react';
import { THEMES } from '../bridge';

export const DEV_DEFAULT_BASE_URL = 'http://127.0.0.1:3456';

export type DevConnection = {
  baseURL: string;
  token: string;
  theme?: string;
  projectName?: string | null;
};

/** The message for a connection the form cannot use, or null when it is usable. */
export function devConnectionError(cfg: { baseURL: string; token: string }): string | null {
  if (cfg.baseURL === '' || cfg.token === '') {
    return 'The connection settings are missing the server address or the token.';
  }
  return null;
}

// Shown only outside the Mac app (no llmide message handler): lets `npm run dev`
// talk to a local server directly. The token is kept in this form's state only.
export function DevConnect({ onConnect }: { onConnect: (cfg: DevConnection) => void }) {
  const [baseURL, setBaseURL] = useState(DEV_DEFAULT_BASE_URL);
  const [token, setToken] = useState('');
  const [theme, setTheme] = useState<string>('dark');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cfg = { baseURL: baseURL.trim(), token: token.trim() };
    const problem = devConnectionError(cfg);
    setError(problem);
    if (problem) return;
    onConnect({ ...cfg, theme, projectName: 'Dev server' });
  };

  return (
    <main className="dev-connect">
      <form className="card dev-form" onSubmit={submit} aria-labelledby="dev-title">
        <h1 id="dev-title" className="card-title">
          Connect to a local server
        </h1>
        <p className="meta">Running outside the LLM-IDE app. Enter the server address and an access token.</p>
        {error ? (
          <p className="banner banner-error" role="alert">
            {error}
          </p>
        ) : null}
        <label className="field">
          <span>Server address</span>
          <input
            name="baseURL"
            type="url"
            required
            autoComplete="off"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Access token</span>
          <input
            name="token"
            type="password"
            required
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Theme</span>
          <select name="theme" value={theme} onChange={(e) => setTheme(e.target.value)}>
            {THEMES.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary">
          Connect
        </button>
      </form>
    </main>
  );
}
