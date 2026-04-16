-- Conversation-tick log: one row per user message in Claude Code (the
-- inject-claude-md hook fires on every UserPromptSubmit, which is exactly
-- the moment we want to capture).
--
-- Joining ticks to mcp_call_logs gives us REAL Mode-A timeliness:
-- "did Claude call the MCP tool in the same turn it heard the relevant
-- info, or did it wait several messages?"

CREATE TABLE IF NOT EXISTS conversation_ticks (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  workspace_id uuid,
  user_id uuid,
  source text NOT NULL DEFAULT 'inject-hook'  -- 'inject-hook' | 'session-start' | other
);
CREATE INDEX IF NOT EXISTS idx_conversation_ticks_ts ON conversation_ticks(ts DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_ticks_workspace ON conversation_ticks(workspace_id, ts DESC);
