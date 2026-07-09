# Token-Efficient Quick Reference

## Command Palette (Copy & Use)

### Finding Things
```bash
# Find exact pattern across files
grep -rn "pattern" --include="*.swift" path/

# Find function definitions
grep -rn "func function_name" --include="*.swift" .

# Find all files in subsystem
find path/to/subsystem/ -name "*.swift" -type f
```

### Reading Things
```bash
# Read specific section only
Read file_path offset:startLine limit:lineCount

# Read test for understanding
Read tests/path/test_file.swift

# Read documentation first
Read docs/relevant-topic.md
```

### Decision Matrix
```
What do you need?
├─ Find pattern? → grep -rn "pattern" path/
├─ Scan multiple files? → Explore agent
├─ Read specific section? → Read file offset:limit
└─ Understand subsystem? → Read docs/ first

How many changes?
├─ 1 file → Edit directly
├─ 2-5 files → Batch changes
└─ 5+ files → Group by type, implement systematically
```

## Token Savings Examples

| Approach | Tokens | Reduction |
|----------|--------|-----------|
| Read 5 full files | 50k | - |
| grep + targeted reads | 5k | 90% |
| Explore agent | 3k | 94% |
| Reference docs | 1k | 98% |

## Workflow Checklist

**Start:**
- [ ] Check docs/session-summary-*.md
- [ ] Check memory/ for guidance
- [ ] Choose approach (grep/explore/read)

**Execute:**
- [ ] Get exact information (grep/explore)
- [ ] Read only relevant sections
- [ ] Make changes efficiently
- [ ] Track with checklist

**End:**
- [ ] Single build verification
- [ ] Single test verification
- [ ] Update session summary

## Quick Patterns

**Bug Fix:**
```bash
grep -rn "bug_pattern" --include="*.swift" Sources/
Read file.swift offset:line limit:10
Edit file.swift old new
swift build && swift test
```

**Feature:**
```bash
grep -rn "similar_feature" --include="*.swift" Sources/
Read reference_file.swift offset:1 limit:50
# Implement following pattern
swift build && swift test
```

**Refactor:**
```bash
grep -rn "pattern_to_refactor" --include="*.swift" Sources/
# List all files, batch implement
swift build && swift test
```

## Common Mistakes to Avoid

❌ Don't read full files when grep works
❌ Don't build after each single change
❌ Don't re-read what's already documented
❌ Don't explore when specific pattern exists

✅ Use grep for patterns
✅ Batch changes, verify once
✅ Reference existing docs
✅ Read only relevant sections

## Target Tokens

- Simple fix: 5-10k tokens
- Medium task: 15-25k tokens
- Complex feature: 30-50k tokens

(Traditional: 50-150k tokens)
