from check_rate_limit_mapping import source_pairs, doc_profile_rows, find_violations


def test_source_pairs_parses_all_forms():
    src = """function rateLimitProfile(url, method) {
  if (method === 'GET') { if (path === '/exp') return 'pE'; return null; }
  if (url === '/a') return 'p1';
  if (url === '/b' || url === '/c') return 'p2';
  if (url.startsWith('/k/')) return 'p3';
}
"""
    pairs = source_pairs(src)
    assert ("/a", "p1") in pairs
    assert ("/b", "p2") in pairs and ("/c", "p2") in pairs
    assert ("/k/", "p3") in pairs
    assert ("/exp", "pE") in pairs


def test_clean_mapping_has_no_violations():
    src = "f(){ if (url === '/a') return 'p1';\n if (url === '/b') return 'p2'; }"
    doc = "| `p1` | 1 | 1/s | `/a` |\n| `p2` | 1 | 1/s | `/b` |"
    # source_pairs needs the function wrapper:
    src = "function rateLimitProfile(url){\n" + src + "\n}"
    assert find_violations(source_pairs(src), doc_profile_rows(doc)) == []


def test_detects_url_under_wrong_profile():
    src = "function rateLimitProfile(url){\n if (url === '/a') return 'p1';\n if (url === '/b') return 'p2';\n}"
    doc = "| `p1` | 1 | 1/s | `/x` |\n| `p2` | 1 | 1/s | `/a`, `/b` |"  # /a wrongly under p2
    violations = find_violations(source_pairs(src), doc_profile_rows(doc))
    assert any("/a" in v and "wrongly" in v for v in violations)


def test_boundary_avoids_substring_false_positive():
    # '/kb/email/test' must not match inside '/kb/email/seen'
    src = "function rateLimitProfile(url){\n if (url === '/kb/email/test') return 'd';\n if (url === '/kb/email/seen') return 'w';\n}"
    doc = "| `d` | 1 | 1/s | `/kb/email/test` |\n| `w` | 1 | 1/s | `/kb/email/seen` |"
    assert find_violations(source_pairs(src), doc_profile_rows(doc)) == []
