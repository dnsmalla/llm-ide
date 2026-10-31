// Write-only secret entry. A secret lives in this object only between typing and the
// submit call; `take()` hands it over once and clears it. It is never put in a URL, a log
// line, an error message, localStorage, or rendered back (the input is type=password and
// the page shows only "stored" / "not set", from the server's `hasKey`).

export interface SecretFieldState {
  /** Number of characters typed; the value itself is not part of the snapshot. */
  length: number;
  /** True when something is typed. */
  filled: boolean;
}

export class SecretField {
  #value = "";

  set(value: string): void {
    this.#value = value;
  }

  get state(): SecretFieldState {
    return { length: this.#value.length, filled: this.#value.length > 0 };
  }

  /** Returns the value and clears the field. A second call returns "". */
  take(): string {
    const v = this.#value;
    this.#value = "";
    return v;
  }

  clear(): void {
    this.#value = "";
  }

  // Keep the secret out of console.log, JSON.stringify and template strings.
  toJSON(): string {
    return "[secret]";
  }
  toString(): string {
    return "[secret]";
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "SecretField { [secret] }";
  }
}

/** What the page shows for a stored key: never the key, never its length. */
export function keyStatusLabel(hasKey: boolean | null, keyRequired: boolean): string {
  if (!keyRequired && hasKey !== true) return "No key needed";
  if (hasKey === null) return "Unknown";
  return hasKey ? "Key stored" : "Key missing";
}

const TOKEN_LIKE = [
  /\bsk-[A-Za-z0-9_-]{8,}/g, // provider-style keys
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}(\.[A-Za-z0-9_-]*)?/g, // JWTs
  /\b(api[_-]?key|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{8,}/g,
];

/** Replaces anything that looks like a credential. Defence in depth for diagnostics and logs. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of TOKEN_LIKE) {
    out = out.replace(re, (m, p1: string | undefined, p2: string | undefined) => (p1 && p2 !== undefined ? `${p1}${p2}[redacted]` : "[redacted]"));
  }
  return out;
}
