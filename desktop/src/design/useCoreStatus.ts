import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Mirrors the Rust `CoreStatus` struct (src-tauri/src/core_host.rs).
export interface CoreStatus {
  url: string;
  adopted: boolean;
  pid: number | null;
  ms_to_healthy: number | null;
  state: "starting" | "ready" | "failed";
  error: string | null;
}

const POLL_MS = 1000;

/**
 * Polls `core_status` until the core is ready or failed. The webview never
 * fetches the Node core directly (its CORS allowlist does not include the Tauri
 * origin); status always comes through a Rust command.
 */
export function useCoreStatus(): { status: CoreStatus | null; pollError: string | null } {
  const [status, setStatus] = useState<CoreStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    let done = false;
    const poll = async () => {
      try {
        const next = await invoke<CoreStatus>("core_status");
        if (done) return;
        setStatus(next);
        setPollError(null);
        if (next.state === "ready" || next.state === "failed") return;
      } catch (e) {
        if (done) return;
        setPollError(String(e));
      }
      timer = window.setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      done = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  return { status, pollError };
}
