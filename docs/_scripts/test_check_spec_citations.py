from check_spec_citations import extract_citations, is_placeholder


def test_extracts_real_repo_paths():
    md = "See `extension/server.mjs:33` and `mac/Sources/LlmIdeMac/App.swift`."
    assert extract_citations(md) == {
        "extension/server.mjs",
        "mac/Sources/LlmIdeMac/App.swift",
    }


def test_strips_line_and_symbol_suffix():
    md = "`extension/kb/db.mjs:112-122` and `extension/core/config.mjs:121`"
    assert extract_citations(md) == {"extension/kb/db.mjs", "extension/core/config.mjs"}


def test_skips_placeholders():
    assert is_placeholder("extension/llm_agent/internal/skills/<name>.md")
    assert is_placeholder(".llmide-auto/<task>/foo.ts")
    assert is_placeholder("kb/migrations/NNNN_name.sql")
    md = "`extension/foo/<name>.mjs` and `.llmide-auto/<task>/x.ts`"
    assert extract_citations(md) == set()


def test_ignores_non_path_backticks_and_prose():
    # bare symbols, prose words with dots, and non-repo paths are not citations
    md = "`buildMatchExpr()`, `MsgType`, `e.g. notes.md`, `/usr/bin/node`, `app.tsx`"
    assert extract_citations(md) == set()


def test_requires_known_root_and_extension():
    # right extension but unknown root → skip; known root but no extension → skip
    md = "`random/path/file.ts` and `extension/server` and `extension/server.mjs`"
    assert extract_citations(md) == {"extension/server.mjs"}
