-- agent.db: the SDK's estimate of the thinking tokens inside a run's output
-- tokens (K1 P2 A8, SDKThinkingTokensMessage). A BREAKDOWN of output_tokens,
-- never an addition: the output total already bills them. 0 when the SDK sent
-- no estimate. Display copy only, like the other token columns.
ALTER TABLE agent_runs ADD COLUMN thinking_tokens INTEGER NOT NULL DEFAULT 0;
