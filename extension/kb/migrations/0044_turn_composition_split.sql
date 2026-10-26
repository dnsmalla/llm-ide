-- Measured split of each v2 chat turn's context (extends 0040). 0040 recorded
-- what LLM-IDE put in as sizes and the first call's real prompt total, but
-- not how that total divides between the parts, so the ~125k cached context a
-- turn re-reads was still an estimate. These columns hold the split.
--
-- Two sources, kept apart so each can be trusted for what it is:
--   * `*_tokens` columns: LLM-IDE-authored text (system append, skill text,
--     llmide tool definitions, the <<<LLMIDE_CONTEXT>>> fence, tool results)
--     sized by the engine at no model cost, as approximate tokens = chars / 4.
--     The chars are exact; the /4 is a rough estimate, not a tokenizer count.
--   * `sdk_*` columns: the SDK's own getContextUsage() 'summary' categories,
--     read once per turn from the live session after `result` (no API calls).
--     Classified by the SDK's `kind` and `isDeferred` first, then an anchored
--     exact name: live sums take only kind 'used' and not deferred, so
--     "MCP tools (deferred)" never inflates "MCP tools". Deferred tool schemas
--     are summed on their own in `sdk_deferred_tools_tokens`. The full list is
--     kept in `sdk_categories` ("name:kind=tokens;...", bounded) so a category
--     the mapping does not know is not lost. Its estimates are the SDK's, not
--     ours. (0044 was edited in place before it was merged or pushed.)
--
-- The builtin tool schemas and the user MCP tool schemas are not visible to
-- the client; their sizes come only from the SDK categories (system tools and
-- MCP tools, the latter including llmide). `user_mcp_servers` is the count.
--
-- Sizes and counts only — never prompt, attachment or tool text.
ALTER TABLE turn_composition ADD COLUMN system_prompt_tokens INTEGER;
ALTER TABLE turn_composition ADD COLUMN skills_append_tokens INTEGER;
ALTER TABLE turn_composition ADD COLUMN llmide_tool_tokens INTEGER;
ALTER TABLE turn_composition ADD COLUMN user_mcp_servers INTEGER;
ALTER TABLE turn_composition ADD COLUMN context_fence_tokens INTEGER;
ALTER TABLE turn_composition ADD COLUMN memory_fence_tokens INTEGER;
ALTER TABLE turn_composition ADD COLUMN skills_fence_tokens INTEGER;
ALTER TABLE turn_composition ADD COLUMN tool_result_chars INTEGER;
ALTER TABLE turn_composition ADD COLUMN tool_result_tokens INTEGER;
ALTER TABLE turn_composition ADD COLUMN sdk_context_total_tokens INTEGER;
ALTER TABLE turn_composition ADD COLUMN sdk_system_prompt_tokens INTEGER;
ALTER TABLE turn_composition ADD COLUMN sdk_system_tools_tokens INTEGER;
ALTER TABLE turn_composition ADD COLUMN sdk_mcp_tools_tokens INTEGER;
ALTER TABLE turn_composition ADD COLUMN sdk_memory_tokens INTEGER;
ALTER TABLE turn_composition ADD COLUMN sdk_messages_tokens INTEGER;
ALTER TABLE turn_composition ADD COLUMN sdk_deferred_tools_tokens INTEGER;
ALTER TABLE turn_composition ADD COLUMN sdk_categories TEXT;
