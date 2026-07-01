---
name: fetch-url
kind: read
schema:
  url:
    type: string
    required: true
    description: Full URL to fetch (https://...). Only public URLs allowed.
---

# fetch-url

Fetch and read the contents of a URL.

## When to use

You have a specific URL (from the user, from search results, or from a GitHub link) and need to read its full contents. Use `web-search` first to find relevant pages, then `fetch-url` to read the ones that look promising.

## Call shape

```
<<<TOOL_CALL>>>
{"name": "fetch-url", "arguments": {"url": "https://github.com/user/repo"}}
<<<END_TOOL_CALL>>>
```

## Result shape

```json
{
  "title": "Page Title",
  "text": "Extracted text content (up to 8KB)..."
}
```

`text` is the readable content of the page. Like `web-search`, this runs
through the assistant's existing Anthropic access (native `web_fetch`, or the
`claude` CLI's built-in fetch via your Claude login); it falls back to a direct
HTTP fetch with HTML stripped to text. No extra setup or key is required.

## Security

Private/localhost URLs are rejected — only public URLs are fetched.
