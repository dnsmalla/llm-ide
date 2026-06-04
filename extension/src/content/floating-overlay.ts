// Floating overlay — injects a minimal "LLM IDE" status pill into the
// meeting page while recording is active.  Clicking "Open" deep-links to
// the native Mac app via the service worker (LAUNCH_MAC_APP message,
// historically called OPEN_POPUP for backwards compat with stored builds).
// We no longer spawn a detached Chrome popup window — the side panel
// covers in-Chrome viewing, and the Mac app covers everything else.

import { MsgType } from '../lib/messages';

// Guard against re-injection — see caption-scraper.ts for rationale.
declare global {
  interface Window {
    __llmideFloatingOverlayInjected?: boolean;
  }
}
if (window.__llmideFloatingOverlayInjected) {
  throw new Error('llmide:floating-overlay-already-injected');
}
window.__llmideFloatingOverlayInjected = true;

const BAR_ID = 'llmide-bar';
let barEl: HTMLDivElement | null = null;

// ── LLM IDE Toolbar Icon ───────────────────────────────────────────
// A small cloud icon that appears on the right edge of the screen,
// styling matching Google Meet's native toolbar. Clicking it opens the app.

function buildBar(): void {
  if (document.getElementById(BAR_ID)) return;

  barEl = document.createElement('div');
  barEl.id = BAR_ID;

  const host = barEl;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    #llmide-icon {
      position: fixed;
      right: 24px;
      bottom: 120px; /* Positioned near the Meet sidebar vertical controls */
      z-index: 2147483647;
      display: none;
      align-items: center;
      justify-content: center;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: rgba(32, 33, 36, 0.95);
      backdrop-filter: blur(8px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(255,255,255,0.1);
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.2, 0, 0, 1);
      user-select: none;
    }
    #llmide-icon.visible { display: flex; }
    #llmide-icon:hover {
      background: rgba(60, 64, 67, 0.95);
      transform: scale(1.05);
    }
    #llmide-icon:active {
      transform: scale(0.95);
    }
    /* The SVG matches the gradient cloud look the user liked */
    svg {
      width: 24px;
      height: 24px;
      fill: none;
      stroke: url(#gradient);
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .badge {
      position: absolute;
      bottom: 8px;
      right: 8px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #34A853; /* Meet green recording color */
      border: 2px solid rgba(32, 33, 36, 1);
      animation: pulse 1.4s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.6; transform: scale(1.1); }
    }
  `;

  const bar = document.createElement('div');
  bar.id = 'llmide-icon';
  bar.title = 'Open LLM IDE';

  // An SVG spark/cloud to closely match the user's screenshot aesthetic
  bar.innerHTML = `
    <svg viewBox="0 0 24 24">
      <defs>
        <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#E233FF" />
          <stop offset="100%" stop-color="#FF6B00" />
        </linearGradient>
      </defs>
      <path d="M17.5 19C19.985 19 22 16.985 22 14.5C22 12.13 20.17 10.2 17.85 10.02C17.38 7.15 14.93 5 12 5C9.52 5 7.4 6.64 6.38 8.86C3.86 9.17 2 11.23 2 13.8C2 16.67 4.33 19 7.2 19H17.5Z"/>
      <circle cx="5" cy="5" r="1.5" fill="url(#gradient)" stroke="none"/>
      <circle cx="19" cy="5" r="1" fill="url(#gradient)" stroke="none"/>
      <circle cx="21" cy="9" r="1.5" fill="url(#gradient)" stroke="none"/>
      <circle cx="3" cy="9" r="1" fill="url(#gradient)" stroke="none"/>
    </svg>
    <div class="badge"></div>
  `;

  bar.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: MsgType.OPEN_POPUP }).catch(() => {});
  });

  shadow.appendChild(style);
  shadow.appendChild(bar);
  document.body.appendChild(host);
}

function showBar(): void {
  if (!barEl) return;
  const bar = barEl.shadowRoot?.getElementById('llmide-icon');
  bar?.classList.add('visible');
}

function hideBar(): void {
  const bar = barEl?.shadowRoot?.getElementById('llmide-icon');
  bar?.classList.remove('visible');
}

// ── Recording events ──────────────────────────────────────────────────

window.addEventListener('llmide:recording-start', () => {
  showBar();
});

window.addEventListener('llmide:recording-stop', () => {
  hideBar();
});

// ── Init ──────────────────────────────────────────────────────────────

buildBar();
