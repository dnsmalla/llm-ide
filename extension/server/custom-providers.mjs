/**
 * Custom Provider Registry
 *
 * Stores user-registered LLM providers synced from the Mac app.
 * Indexed by custom:uuid format for fast lookups during code-assist calls.
 *
 * Architecture:
 * - Mac app maintains list of CustomProvider in UserDefaults
 * - On save/update/delete, Mac syncs to /kb/custom-providers endpoint
 * - Backend keeps in-memory registry (keyed by custom:uuid)
 * - When code-assist uses custom:uuid model, backend looks up baseURL + vault key
 */

// In-memory registry: { "custom:uuid": { name, baseURL, vaultKey, ... } }
const customProvidersRegistry = new Map();

export function getCustomProvider(providerId) {
  return customProvidersRegistry.get(providerId);
}

/**
 * Sync custom providers from Mac app.
 * Called on app startup and whenever user adds/edits/deletes a custom provider.
 */
export function syncCustomProviders(providers = []) {
  customProvidersRegistry.clear();

  for (const p of providers) {
    if (!p.id || !p.name || !p.baseURL) continue;  // Skip invalid entries

    const key = `custom:${p.id}`;
    customProvidersRegistry.set(key, {
      id: p.id,
      name: p.name,
      baseURL: p.baseURL,
      vaultKey: p.apiKey,  // e.g., "custom.glm.apiKey"
      models: p.models || [],
      isOpenAICompatible: p.isOpenAICompatible !== false,
      isEnabled: p.isEnabled !== false,
      // Optional Anthropic-format door (Z.AI `…/api/anthropic`, DeepSeek
      // `…/anthropic`, Ollama `:11434`). Only the Agent SDK engine reads it:
      // the legacy loop keeps dispatching to `baseURL` (OpenAI form). Null
      // means "this provider cannot take the Agent engine".
      anthropicBaseURL: typeof p.anthropicBaseURL === 'string' && p.anthropicBaseURL.trim()
        ? p.anthropicBaseURL.trim().replace(/\/+$/, '')
        : null,
    });
  }

  process.stderr.write(`[custom-providers] synced ${customProvidersRegistry.size} provider(s)\n`);
}

/**
 * HTTP handler for POST /kb/custom-providers
 *
 * Request body: { providers: [CustomProvider, ...] }
 * Response: { success: true, count: number }
 */
export async function handleCustomProvidersSync(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
    if (body.length > 100_000) {  // 100KB limit
      req.connection.destroy();
    }
  });

  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const providers = Array.isArray(data.providers) ? data.providers : [];
      syncCustomProviders(providers);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, count: providers.length }));
    } catch (err) {
      process.stderr.write(`[custom-providers-sync] error: ${err.message}\n`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
  });
}
