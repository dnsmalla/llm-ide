// Web utilities for agent: SerpAPI search and URL fetch.

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Call SerpAPI to search the web.
 * Returns { results: [{title, link, snippet}, ...], searchParameters: {...} }
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
      searchParameters: data.search_parameters
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
