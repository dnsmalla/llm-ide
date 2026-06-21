from extract_agent_skills import parse_skill, discover


def test_parse_skill_reads_frontmatter():
    md = "---\nname: search-kb\nkind: read\ndescription: Search the KB.\n---\n# When to use\n..."
    s = parse_skill(md, "internal/skills/search-kb.md")
    assert s is not None
    assert s["name"] == "search-kb" and s["kind"] == "read"
    assert s["path"].endswith("search-kb.md")


def test_non_skill_markdown_is_ignored():
    # A prompt file with no `kind` is not a skill.
    assert parse_skill("---\ntitle: x\n---\nbody", "global/prompt.md") is None


def test_real_source_has_known_skills():
    skills = discover()
    names = {s["name"] for s in skills}
    assert {"search-kb", "ask-internal", "ask-subagent"} <= names
    # every discovered skill has a kind of read or write
    assert all(s["kind"] in ("read", "write") for s in skills)
