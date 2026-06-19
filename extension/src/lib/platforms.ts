/**
 * Centralized platform registry.
 *
 * Every platform-specific string (host patterns, URL globs, display
 * names, tab-title suffixes) lives here.  Content scripts, the service
 * worker, the side panel, and the agent hook all import from this
 * module instead of hard-coding their own copies.
 *
 * To add a new meeting platform:
 *   1. Add an entry to PLATFORMS below.
 *   2. Implement a caption reader in content/caption-scraper.ts
 *      and register it in CAPTION_READERS.
 *   3. Implement speaker/participant detectors in content/speaker-detector.ts
 *      and register them in the detector maps.
 *   4. Update manifest.json host_permissions + content_scripts.matches
 *      (these can't be derived at runtime in MV3).
 */

export type PlatformId = 'meet' | 'teams' | 'zoom';

interface PlatformDef {
  /** Internal key — matches PlatformId. */
  id: PlatformId;
  /** User-facing name. */
  displayName: string;
  /** Hostnames that identify this platform (checked via `includes`). */
  hosts: string[];
  /** Regex fragments stripped from browser tab titles. */
  titleSuffixes: string[];
}

/**
 * The registry.  Order matters — first match wins in `detectPlatform`.
 */
export const PLATFORMS: readonly PlatformDef[] = [
  {
    id: 'meet',
    displayName: 'Google Meet',
    hosts: ['meet.google.com'],
    titleSuffixes: ['Google Meet'],
  },
  {
    id: 'teams',
    displayName: 'Microsoft Teams',
    hosts: ['teams.microsoft.com', 'teams.live.com'],
    titleSuffixes: ['Microsoft Teams', 'Teams'],
  },
  {
    id: 'zoom',
    displayName: 'Zoom',
    hosts: ['zoom.us'],
    titleSuffixes: ['Zoom Meeting', 'Zoom'],
  },
] as const;

// ── Derived helpers (computed once, reused everywhere) ────────────

/**
 * Detect which platform a URL belongs to, or `null` if none match.
 * Used by content scripts, service worker, and side panel.
 */
export function detectPlatformFromUrl(url: string): PlatformId | null {
  try {
    const host = new URL(url).hostname;
    for (const p of PLATFORMS) {
      for (const h of p.hosts) {
        if (host === h || host.endsWith(`.${h}`)) return p.id;
      }
    }
  } catch {
    // Malformed URL — not a platform page.
  }
  return null;
}

/**
 * Quick check: does this URL belong to any supported platform?
 */
export function isSupportedUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  return detectPlatformFromUrl(url) !== null;
}

/**
 * Strip platform suffixes from a browser tab title.
 * "Team standup - Google Meet" → "Team standup"
 */
export function stripPlatformSuffix(raw: string): string {
  const suffixes = PLATFORMS.flatMap((p) => p.titleSuffixes).join('|');
  const re = new RegExp(`\\s+[-–|·]\\s*(${suffixes}).*$`, 'i');
  return raw.replace(re, '').replace(/\s+/g, ' ').trim();
}
