// Shared state of the saved local login: the flags and notes the login panel, the Settings row and the sign-out paths
// read and write. It has no imports on purpose: the Settings adapter clears the flags, and must not pull in the shell's
// core client (local-session.ts) to do so.

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: (): T => value,
    set(next: T): void {
      if (Object.is(value, next)) return;
      value = next;
      for (const l of [...listeners]) l();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

// The saved password was refused: the login panel says so until a sign-in succeeds or the user signs out.
const rejectedStore = store(false);
// Sign-out (or unticked sign-in) could not remove the saved login: Settings shows it until a forget succeeds.
const forgetStore = store(false);
// A one-line note about the last sign-in's saving (not saved on an adopted core; could not remove the login).
const noteStore = store<string | null>(null);

export const savedLoginRejected = (): boolean => rejectedStore.get();
export const subscribeSavedLoginRejected = (listener: () => void): (() => void) => rejectedStore.subscribe(listener);
export const setSavedLoginRejected = (refused: boolean): void => rejectedStore.set(refused);
export const clearSavedLoginRejected = (): void => rejectedStore.set(false);

export const savedLoginForgetFailed = (): boolean => forgetStore.get();
export const subscribeSavedLoginForgetFailed = (listener: () => void): (() => void) => forgetStore.subscribe(listener);
export const setSavedLoginForgetFailed = (failed: boolean): void => forgetStore.set(failed);
export const clearSavedLoginForgetFailed = (): void => forgetStore.set(false);

export const savedLoginNote = (): string | null => noteStore.get();
export const subscribeSavedLoginNote = (listener: () => void): (() => void) => noteStore.subscribe(listener);
export const setSavedLoginNote = (text: string | null): void => noteStore.set(text);
