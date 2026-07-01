import { useCallback, useEffect, useState } from 'react';
import {
  apiLogin,
  apiLogout,
  apiRegister,
  apiWellKnown,
  clearSession,
  getSession,
  loadStoredSession,
  onSessionChange,
  setSession,
  ServerError,
} from '../../lib/config';

interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

export function useSession() {
  const [user, setUser] = useState<SessionUser | null>(getSession().user);
  const [authenticated, setAuthenticated] = useState<boolean>(!!getSession().accessToken);
  const [loading, setLoading] = useState(true);
  const [registrationOpen, setRegistrationOpen] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Subscribe to session-state changes from anywhere (token refresh,
  // explicit logout, server-side revocation propagating through 401).
  useEffect(() => {
    const off = onSessionChange((s) => {
      setUser(s.user);
      setAuthenticated(!!s.accessToken);
    });
    return off;
  }, []);

  // Boot: try to restore a session from the persisted refresh token.
  // While that's in flight, render a quick loading state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meta = await apiWellKnown().catch(() => null);
        if (!cancelled && meta) setRegistrationOpen(meta.registrationOpen);
        await loadStoredSession();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiLogin(email, password);
      setSession({
        accessToken: res.accessToken,
        refreshToken: res.refreshToken,
        user: res.user,
      });
      return true;
    } catch (err) {
      const msg =
        err instanceof DOMException && err.name === 'AbortError'
          ? 'Server not responding — check that it is running.'
          : err instanceof ServerError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Login failed';
      setError(msg);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const register = useCallback(
    async (email: string, password: string, displayName?: string) => {
      setBusy(true);
      setError(null);
      try {
        await apiRegister(email, password, displayName);
        return await login(email, password);
      } catch (err) {
        const msg =
          err instanceof DOMException && err.name === 'AbortError'
            ? 'Server not responding — check that it is running.'
            : err instanceof ServerError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'Registration failed';
        setError(msg);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [login],
  );

  const logout = useCallback(async () => {
    await apiLogout(false);
    clearSession();
  }, []);

  return { user, authenticated, loading, busy, error, registrationOpen, login, register, logout };
}
