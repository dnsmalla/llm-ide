// Web utilities for the agent.
//
// Two families of backend, mirroring how runClaude already resolves Anthropic
// credentials (see agents/runtime.mjs):
//   1. Anthropic-native (preferred) — "like Claude does web search". The
//      Messages API has built-in server-side `web_search` / `web_fetch` tools
//      (searchWebViaAnthropic / fetchUrlViaAnthropic, reuse the Anthropic API
//      key), and the `claude` CLI has the same tools built in for the no-key
//      subscription path (searchWebViaCli / fetchUrlViaCli). Neither needs a
//      SerpAPI account.
//   2. Fallbacks — SerpAPI (searchWeb) and a direct HTTP fetch + HTML strip
//      (fetchUrl), used only when no Anthropic credential is available.
// The handlers pick a backend at call time; this module just exposes each one.

import { spawnCli, minimalCliEnv, anthropicWebCliArgs } from './providers.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;
const ANTHROPIC_TIMEOUT_MS = 45_000;
const CLI_TIMEOUT_MS = 60_000;
const ANTHROPIC_VERSION = process.env.LLMIDE_ANTHROPIC_VERSION || '2023-06-01';

// Web-tool tool versions. `_20260209` adds server-side dynamic filtering and
// is supported on Claude 4.6+ (the app's default model). Overridable for older
// models / future bumps.
const WEB_SEARCH_TOOL_TYPE = process.env.LLMIDE_WEB_SEARCH_TOOL || 'web_search_20260209';
const WEB_FETCH_TOOL_TYPE  = process.env.LLMIDE_WEB_FETCH_TOOL  || 'web_fetch_20260209';

// Model used for the native web-tool calls. Reuses the app-wide LLMIDE_MODEL so
// the search sub-call obeys the same model policy as the rest of the agent.
function webModel() {
  return process.env.LLMIDE_SEARCH_MODEL || process.env.LLMIDE_MODEL || 'claude-sonnet-4-6';
}

// POST a single Messages request and walk pause_turn turns (server-tool loops
// can pause when they hit the per-turn tool-use cap). Bounded to avoid runaway.
async function runAnthropicWebTool({ apiKey, tool, userText, timeoutMs, signal }) {
  if (!apiKey) throw new Error('Anthropic API key required for native web tools');
  let messages = [{ role: 'user', content: userText }];
  let last;
  for (let turn = 0; turn < 4; turn++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: webModel(), max_tokens: 2048, tools: [tool], messages }),
      signal: signal || AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
      throw new Error(`Anthropic web tool ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    last = await res.json();
    if (last.stop_reason === 'pause_turn' && Array.isArray(last.content)) {
      messages = [...messages, { role: 'assistant', content: last.content }];
      continue;
    }
    break;
  }
  return last;
}

// Collect text blocks (the model's synthesis) and any sources surfaced by a
// web_search/web_fetch tool-result block.
function parseAnthropicWeb(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const answer = blocks.filter(b => b?.type === 'text').map(b => b.text).join('').trim();
  const sources = [];
  for (const b of blocks) {
    if ((b?.type === 'web_search_tool_result' || b?.type === 'web_fetch_tool_result')
        && Array.isArray(b.content)) {
      for (const r of b.content) {
        if (r && r.url) sources.push({ title: r.title || r.url, url: r.url });
      }
    }
  }
  return { answer, sources };
}

/**
 * Native web search via the Anthropic Messages API's built-in `web_search`
 * tool. Reuses the caller's Anthropic API key — no SerpAPI.
 * Returns { answer: "synthesized summary", sources: [{title, url}, ...] }.
 */
export async function searchWebViaAnthropic(query, { apiKey, timeoutMs = ANTHROPIC_TIMEOUT_MS, signal } = {}) {
  if (!query || typeof query !== 'string') throw new Error('Query must be a non-empty string');
  const data = await runAnthropicWebTool({
    apiKey,
    tool: { type: WEB_SEARCH_TOOL_TYPE, name: 'web_search', max_uses: 5 },
    userText: `Search the web for: ${query}\n\nReturn a concise summary of what you find, and list the most relevant sources with their URLs.`,
    timeoutMs,
    signal,
  });
  return parseAnthropicWeb(data);
}

/**
 * Native URL read via the Anthropic Messages API's built-in `web_fetch` tool.
 * Returns { title, text } (text is the model's synthesis of the page).
 */
export async function fetchUrlViaAnthropic(urlString, { apiKey, timeoutMs = ANTHROPIC_TIMEOUT_MS, signal } = {}) {
  if (!urlString || typeof urlString !== 'string') throw new Error('URL must be a non-empty string');
  const data = await runAnthropicWebTool({
    apiKey,
    tool: { type: WEB_FETCH_TOOL_TYPE, name: 'web_fetch', max_uses: 3 },
    userText: `Fetch this URL and report its contents: ${urlString}`,
    timeoutMs,
    signal,
  });
  const { answer, sources } = parseAnthropicWeb(data);
  return { title: sources[0]?.title || '', text: answer };
}

// Build the minimal env for a Claude CLI web subprocess (subscription login).
// Mirrors runtime.mjs's Anthropic CLI fallback: forward only ANTHROPIC_BASE_URL
// (+ ANTHROPIC_API_KEY when the operator set one) — never the full env.
function cliWebEnv() {
  return minimalCliEnv({
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '',
    ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
  });
}

/**
 * Native web search via the `claude` CLI's built-in WebSearch tool — the
 * subscription-login path (no API key). Returns { answer, sources:[] } (the
 * CLI returns synthesized text with URLs inline rather than structured rows).
 */
export async function searchWebViaCli(query, { timeoutMs = CLI_TIMEOUT_MS, signal } = {}) {
  if (!query || typeof query !== 'string') throw new Error('Query must be a non-empty string');
  const prompt = `Search the web for: ${query}\n\nReturn a concise summary and list the most relevant sources with their URLs.`;
  const { stdout } = await spawnCli('anthropic', prompt, {
    args: anthropicWebCliArgs(prompt, { tool: 'WebSearch' }),
    env: cliWebEnv(),
    timeoutMs,
    signal,
  });
  return { answer: String(stdout || '').trim(), sources: [] };
}

/**
 * Native URL read via the `claude` CLI's built-in WebFetch tool.
 * Returns { title:'', text } (CLI gives synthesized text, no separate title).
 */
export async function fetchUrlViaCli(urlString, { timeoutMs = CLI_TIMEOUT_MS, signal } = {}) {
  if (!urlString || typeof urlString !== 'string') throw new Error('URL must be a non-empty string');
  const prompt = `Fetch this URL and report its contents: ${urlString}`;
  const { stdout } = await spawnCli('anthropic', prompt, {
    args: anthropicWebCliArgs(prompt, { tool: 'WebFetch' }),
    env: cliWebEnv(),
    timeoutMs,
    signal,
  });
  return { title: '', text: String(stdout || '').trim() };
}

/**
 * Call SerpAPI to search the web (optional fallback backend).
 * Returns { results: [{title, link, snippet}, ...] }.
 */
export async function searchWeb(query, { apiKey, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!apiKey) {
    throw new Error('SerpAPI key required. Set in vault or LLMIDE_SERPAPI_KEY env var.');
  }
  if (!query || typeof query !== 'string') {
    throw new Error('Query must be a non-empty string');
  }

  const url = new URL('https://serpapi.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('api_key', apiKey);

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SerpAPI ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return {
      results: (data.organic_results || []).slice(0, 10).map(r => ({
        title: r.title,
        link: r.link,
        snippet: r.snippet || ''
      })),
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Fetch a URL and extract text content.
 * Returns { text: "extracted markdown", title: "page title" }
 */
export async function fetchUrl(urlString, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!urlString || typeof urlString !== 'string') {
    throw new Error('URL must be a non-empty string');
  }

  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${urlString}`);
    }
    const html = await res.text();
    const title = extractTitle(html);
    const text = extractTextContent(html);
    return { text, title };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// Extract <title> from HTML.
function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : '';
}

// Extract readable text from HTML, stripping tags and normalizing whitespace.
function extractTextContent(html) {
  // Remove script, style tags
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode entities
  text = text.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  // Normalize whitespace
  text = text.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
  return text.slice(0, 8000); // Cap at 8KB
}
