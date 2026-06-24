---
name: web-search
kind: read
schema:
  query:
    type: string
    required: true
    minLength: 1
    maxLength: 256
    description: Web search query (e.g., "how to implement OAuth in Node.js")
---

# web-search

Search the web and get a synthesized summary plus the sources behind it.

## When to use

The user asks a question that requires current information not in the local codebase or LLM IDE app state (e.g., "what's the latest Node.js release", "find examples of X on GitHub"). Do not use for questions about the local code or the app itself — use `search-kb` or `ask-internal` instead.

## Call shape

```
<<<TOOL_CALL>>>
{"name": "web-search", "arguments": {"query": "..."}}
<<<END_TOOL_CALL>>>
```

## Result shape

```json
{
  "answer": "A concise summary of what the search found...",
  "sources": [
    { "title": "Page Title", "url": "https://example.com/page" }
  ],
  "count": 1
}
```

`answer` is a summary synthesized from live search results. `sources` lists the
pages behind it — fetch any of them in full via `fetch-url` when you need more
than the summary.

## Backends

No setup is required in the common case — web search runs through the same
Anthropic access the assistant already uses (the Anthropic API key when one is
configured, otherwise the `claude` CLI's built-in search via your Claude login).
A SerpAPI key (Settings → Providers) is only an optional fallback.
