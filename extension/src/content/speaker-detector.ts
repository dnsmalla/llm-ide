// Detects the active speaker on Google Meet, Microsoft Teams, and Zoom (web)
// Sends speaker name to the side panel via chrome.runtime messages

import { MsgType, type Message } from '../lib/messages';
import { debug } from '../lib/config';
import { detectPlatformFromUrl, type PlatformId } from '../lib/platforms';

// Guard against re-injection — see caption-scraper.ts for rationale.
declare global {
  interface Window {
    __meetnotesSpeakerDetectorInjected?: boolean;
  }
}
if (window.__meetnotesSpeakerDetectorInjected) {
  debug('[speaker-detector] already injected — skipping re-init');
  throw new Error('meetnotes:speaker-detector-already-injected');
}
window.__meetnotesSpeakerDetectorInjected = true;

type Platform = PlatformId;

let lastSpeaker = '';
let speakerInterval: ReturnType<typeof setInterval> | null = null;
let participantInterval: ReturnType<typeof setInterval> | null = null;

function detectPlatform(): Platform | null {
  return detectPlatformFromUrl(window.location.href);
}

function sendActiveSpeaker(speaker: string) {
  const msg: Message = { type: MsgType.ACTIVE_SPEAKER, speaker };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function sendParticipants(participants: string[]) {
  const msg: Message = { type: MsgType.PARTICIPANTS_LIST, participants };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ─── Google Meet ────────────────────────────────────────────────────────────

function getMeetActiveSpeaker(): string | null {
  const tiles = document.querySelectorAll('[data-participant-id]');
  for (const tile of tiles) {
    // Check for speaking indicators
    const isSpeaking =
      tile.querySelector('[data-is-speaking="true"]') ||
      tile.querySelector('[class*="speaking"]') ||
      tile.querySelector('[class*="active-speaker"]');

    if (isSpeaking) {
      return (
        tile.querySelector('[data-self-name]')?.getAttribute('data-self-name') ||
        tile.querySelector('[data-tooltip]')?.getAttribute('data-tooltip') ||
        null
      );
    }

    // Check for animated audio bars
    const audioBars = tile.querySelectorAll('[class*="audio"], [class*="voice"]');
    for (const bar of audioBars) {
      const style = window.getComputedStyle(bar);
      if (style.animationName && style.animationName !== 'none') {
        return (
          tile.querySelector('[data-self-name]')?.getAttribute('data-self-name') ||
          tile.querySelector('[data-tooltip]')?.getAttribute('data-tooltip') ||
          null
        );
      }
    }
  }
  return null;
}

function getMeetParticipants(): string[] {
  const names = new Set<string>();
  document.querySelectorAll('[data-self-name]').forEach((el) => {
    const name = el.getAttribute('data-self-name');
    if (name) names.add(name);
  });
  return Array.from(names);
}

// ─── Microsoft Teams ────────────────────────────────────────────────────────

function getTeamsActiveSpeaker(): string | null {
  // Check roster for speaking indicator
  const roster = document.querySelectorAll('[data-cid="roster-participant"], [data-tid]');
  for (const item of roster) {
    const isSpeaking =
      item.querySelector('[data-cid="speaking-indicator"]') ||
      item.querySelector('[class*="speaking"]') ||
      item.querySelector('[class*="is-active-speaker"]');

    if (isSpeaking) {
      return (
        item.querySelector('[data-cid="display-name"]')?.textContent?.trim() ||
        item.getAttribute('aria-label')?.split(',')[0]?.trim() ||
        null
      );
    }
  }

  // Check video tiles for active speaker highlight
  const videoTiles = document.querySelectorAll('[data-cid="calling-participant-stream"], [class*="video-tile"]');
  for (const tile of videoTiles) {
    const isActive =
      tile.classList.toString().includes('active-speaker') ||
      tile.querySelector('[class*="active-speaker"]');

    if (isActive) {
      return (
        tile.querySelector('[data-cid="display-name"]')?.textContent?.trim() ||
        tile.querySelector('[class*="display-name"]')?.textContent?.trim() ||
        null
      );
    }
  }

  // Active speaker banner
  const banner = document.querySelector('[data-cid="active-speaker-name"]');
  return banner?.textContent?.trim() || null;
}

function getTeamsParticipants(): string[] {
  const names = new Set<string>();
  document.querySelectorAll('[data-cid="display-name"]').forEach((el) => {
    const name = el.textContent?.trim();
    if (name && name.length < 50) names.add(name);
  });
  return Array.from(names);
}

// ─── Zoom (web client) ─────────────────────────────────────────────────────

function getZoomActiveSpeaker(): string | null {
  // Video tiles with active speaker highlight
  const tiles = document.querySelectorAll(
    '[class*="video-avatar"], [class*="gallery-video-container"]'
  );
  for (const tile of tiles) {
    const classList = tile.classList.toString();
    if (classList.includes('active-speaker') || classList.includes('speaking')) {
      const name =
        tile.querySelector('[class*="display-name"]')?.textContent?.trim() ||
        tile.querySelector('[class*="participant-name"]')?.textContent?.trim();
      if (name) return name;
    }
  }

  // Active speaker name label
  const label = document.querySelector('[class*="active-speaker-name"]');
  return label?.textContent?.trim() || null;
}

function getZoomParticipants(): string[] {
  const names = new Set<string>();
  document.querySelectorAll('[class*="participants-item"] [class*="name"], [class*="display-name"]')
    .forEach((el) => {
      const name = el.textContent?.trim();
      if (name && name.length < 50) names.add(name);
    });
  return Array.from(names);
}

// ─── Detection loop ─────────────────────────────────────────────────────────

const speakerDetectors: Record<Platform, () => string | null> = {
  meet: getMeetActiveSpeaker,
  teams: getTeamsActiveSpeaker,
  zoom: getZoomActiveSpeaker,
};

const participantDetectors: Record<Platform, () => string[]> = {
  meet: getMeetParticipants,
  teams: getTeamsParticipants,
  zoom: getZoomParticipants,
};

function cleanup() {
  if (speakerInterval) { clearInterval(speakerInterval); speakerInterval = null; }
  if (participantInterval) { clearInterval(participantInterval); participantInterval = null; }
  // Reset the de-dup cache — if the script ever restarts (BFCache restore,
  // SPA nav back into meet.google.com) we want the first speaker detection
  // after restart to broadcast, not be silently suppressed as "unchanged".
  lastSpeaker = '';
}

function startDetection() {
  const platform = detectPlatform();
  if (!platform) return;

  debug(`Speaker detection active on ${platform}`);

  const getSpeaker = speakerDetectors[platform];
  const getParticipants = participantDetectors[platform];

  // Initial participant list (after DOM settles)
  setTimeout(() => {
    const list = getParticipants();
    if (list.length > 0) sendParticipants(list);
  }, 3000);

  // Poll for active speaker (1s is sufficient, 500ms is wasteful)
  speakerInterval = setInterval(() => {
    const speaker = getSpeaker();
    if (speaker && speaker !== lastSpeaker) {
      lastSpeaker = speaker;
      sendActiveSpeaker(speaker);
    }
  }, 1000);

  // Refresh participants every 30s
  participantInterval = setInterval(() => {
    const list = getParticipants();
    if (list.length > 0) sendParticipants(list);
  }, 30_000);
}

// Cleanup on page unload
window.addEventListener('beforeunload', cleanup);

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startDetection);
} else {
  startDetection();
}
