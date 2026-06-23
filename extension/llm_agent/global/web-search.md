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

Search the web and get ranked results with snippets.

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
  "results": [
    {
      "title": "Page Title",
      "link": "https://example.com/page",
      "snippet": "A brief snippet from the page..."
    }
  ],
  "count": 5
}
```

Each result is ranked by relevance. Use the snippets to decide whether to fetch the full page via `fetch-url`.
