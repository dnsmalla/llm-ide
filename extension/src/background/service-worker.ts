import { MsgType } from '../lib/messages';
import { getServerUrl } from '../lib/config';
import { isSupportedUrl } from '../lib/platforms';

// ── Mac-app deep link ─────────────────────────────────────────────────
// We used to spawn a detached Chrome popup window of the side panel
// when recording started.  That created a "second screen" alongside
// the side panel and the Mac app — confusing.  Now OPEN_POPUP just
// opens a tab to the server's /launch-app endpoint, which 302s into
// the meetnotes:// scheme so the native Mac app comes to the front.
// (We can't navigate directly to a custom scheme from a chrome-extension://
// origin — Chrome MV3 silently blocks it.  The server redirect bypasses
// that.)

async function openMacAppDeepLink(): Promise<void> {
  try {
    const serverUrl = await getServerUrl();
    const url = `${serverUrl}/launch-app?to=transcript`;
    await chrome.tabs.create({ url, active: false });
  } catch (err) {
    console.error('[MeetNotes] Failed to open Mac app deep link:', err);
  }
}

// ── Content script injection ──────────────────────────────────────────

async function ensureContentScriptInjected(tabId: number, url: string): Promise<boolean> {
  if (!isSupportedUrl(url)) return true;

  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: MsgType.PING });
    if (response?.pong) return true;
  } catch {
    // Not injected — fall through
  }

  // Secondary check: if the SW message listener happens to be detached
  // mid-respawn but the content script IS already loaded, PING fails
  // even though injection isn't actually needed. Probe the page-side
  // sentinel that each content script sets at boot — if any of them
  // is set, the scripts are already there and re-injecting would only
  // produce a red "already-injected" throw in the page console.
  try {
    const [pageResult] = await chrome.scripting.executeScript({
      target: { tabId },
      // Synchronously inlined — must not import anything; runs in the
      // page world. Returns true if any of the three content scripts
      // has set its sentinel.
      func: () => Boolean(
        // @ts-ignore window augmentation lives in each content script
        (window as any).__meetnotesCaptionScraperInjected
          // @ts-ignore
          || (window as any).__meetnotesSpeakerDetectorInjected
          // @ts-ignore
          || (window as any).__meetnotesFloatingOverlayInjected
      ),
    });
    if (pageResult?.result === true) return true;
  } catch {
    // chrome.scripting.executeScript failed (tab gone, permission
    // missing, etc.) — fall through to the normal injection path.
  }

  try {
    const manifest = chrome.runtime.getManifest();
    const files: string[] = [];
    for (const cs of manifest.content_scripts || []) {
      if (cs.js) files.push(...cs.js);
    }
    if (files.length === 0) return false;

    await chrome.scripting.executeScript({ target: { tabId }, files });
    return true;
  } catch (err) {
    console.error('[MeetNotes] Failed to inject content script:', err);
    return false;
  }
}

// ── Message router ────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Only accept messages from our own extension's contexts (side panel,
  // popup, content scripts injected by us).  Messages from other
  // extensions arrive without `sender.id` set to ours; web pages
  // can't reach onMessage at all unless the manifest opts in via
  // `externally_connectable`, which we don't.  Defense in depth.
  if (_sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false });
    return false;
  }
  if (typeof message !== 'object' || message === null || !('type' in message)) {
    sendResponse({ ok: false });
    return false;
  }

  const type = (message as { type: unknown }).type;

  // Deep-link to the Mac app.  The message name OPEN_POPUP is
  // historical; it now opens the native app via /launch-app rather
  // than spawning a Chrome window.
  if (type === MsgType.OPEN_POPUP) {
    if (_sender.tab?.windowId) {
      // @ts-ignore SidePanel API might not be fully typed depending on standard Chrome TS typings
      if (chrome.sidePanel && chrome.sidePanel.open) {
        chrome.sidePanel.open({ windowId: _sender.tab.windowId }).catch(console.error);
      }
    }
    openMacAppDeepLink().catch(console.error);
    sendResponse({ ok: true });
    return false;
  }

  if (type === MsgType.START_CAPTION_SCRAPING || type === MsgType.STOP_CAPTION_SCRAPING) {
    // Async work: we must return `true` from the listener so Chrome keeps the
    // message channel open until we call sendResponse(). Previously this
    // branch fell through to sendResponse({ok:true}) + return false, which
    // closed the channel before injection finished — callers awaiting the
    // promise saw a synchronous ok with no relation to actual success.
    (async () => {
      try {
        // Patterns MUST match manifest host_permissions exactly.
        // chrome.scripting.executeScript requires the target URL to be
        // covered by host_permissions; querying a broader set just
        // produces inject_failed errors for tabs we can't act on.
        const tabs = await chrome.tabs.query({
          url: [
            'https://meet.google.com/*',
            'https://teams.microsoft.com/l/*',
            'https://teams.microsoft.com/_*',
            'https://teams.microsoft.com/v2/*',
            'https://teams.live.com/_*',
            'https://teams.live.com/v2/*',
            'https://zoom.us/wc/*',
            'https://zoom.us/j/*',
            'https://*.zoom.us/wc/*',
            'https://*.zoom.us/j/*',
          ],
        });
        const results: Array<{ tabId: number; ok: boolean; error?: string }> = [];
        for (const tab of tabs) {
          if (!tab.id || !tab.url) continue;
          if (type === MsgType.START_CAPTION_SCRAPING) {
            const injected = await ensureContentScriptInjected(tab.id, tab.url);
            if (!injected) {
              results.push({ tabId: tab.id, ok: false, error: 'inject_failed' });
              continue;
            }
            // Wait for the content script to register its listener.
            // Poll with PING (up to 5 attempts, 150ms apart) instead
            // of a blind 200ms sleep — handles slow pages gracefully
            // and returns faster on fast ones.
            let ready = false;
            for (let attempt = 0; attempt < 5; attempt++) {
              try {
                const pong = await chrome.tabs.sendMessage(tab.id, { type: MsgType.PING });
                if (pong?.pong) { ready = true; break; }
              } catch { /* not ready yet */ }
              await new Promise((r) => setTimeout(r, 150));
            }
            if (!ready) {
              results.push({ tabId: tab.id, ok: false, error: 'script_not_ready' });
              continue;
            }
            try {
              await chrome.tabs.sendMessage(tab.id, message);
              results.push({ tabId: tab.id, ok: true });
            } catch (e) {
              results.push({ tabId: tab.id, ok: false, error: String(e) });
            }
          } else {
            try {
              await chrome.tabs.sendMessage(tab.id, message);
              results.push({ tabId: tab.id, ok: true });
            } catch (e) {
              results.push({ tabId: tab.id, ok: false, error: String(e) });
            }
          }
        }
        sendResponse({ ok: true, results });
      } catch (err) {
        console.error('[MeetNotes] caption scraping dispatch failed:', err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true; // keep channel open for async sendResponse
  }

  sendResponse({ ok: true });
  return false;
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
