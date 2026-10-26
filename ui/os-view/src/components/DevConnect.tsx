import { useState, type FormEvent } from 'react';
import type { OsController } from '../controller';
import { THEMES } from '../bridge';

export const DEV_DEFAULT_BASE_URL = 'http://127.0.0.1:3456';

// Shown only outside the Mac app (no llmide message handler): lets `npm run dev`
// talk to a local server directly. The token is kept in this form's state only.
export function DevConnect({ controller }: { controller: OsController }) {
  const [baseURL, setBaseURL] = useState(DEV_DEFAULT_BASE_URL);
  const [token, setToken] = useState('');
  const [theme, setTheme] = useState<string>('dark');

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    controller.configure({ baseURL: baseURL.trim(), token: token.trim(), theme, projectName: 'Dev server' });
  };

  return (
    <form className="card card-wide dev-form" onSubmit={submit} aria-labelledby="dev-title">
      <h2 id="dev-title" className="card-title">
        Connect to a local server
      </h2>
      <p className="meta">Running outside the LLM-IDE app. Enter the server address and an access token.</p>
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
  );
}
