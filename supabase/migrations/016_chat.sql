-- Chat conversations now live inside Delma (the app IS the chat surface).
-- Each workspace has many conversations; each conversation has ordered messages.
-- Messages may be user prompts, assistant responses (with tool calls), tool
-- results, or system messages.
--
-- Persisting here instead of client-only means: refresh works, switch device
-- works, teammates can see the same conversation, and the quality lab can
-- replay real conversations.

CREATE TABLE IF NOT EXISTS conversations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid,                          -- conversation starter
  title        text,                          -- auto-generated from first turn
  archived     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content         text,
  tool_calls      jsonb,                      -- array on assistant turns
  tool_call_id    text,                       -- on tool role, ties back to the call
  tool_name       text,                       -- denormalized for quick filtering
  tokens_in       int,
  tokens_out      int,
  model           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);

-- Token usage + rate limit accounting. One row per user per month; cheap to
-- query, upserted on every chat turn.
CREATE TABLE IF NOT EXISTS token_usage (
  user_id      uuid NOT NULL,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  period_start date NOT NULL,                 -- first-of-month
  tokens_in    bigint NOT NULL DEFAULT 0,
  tokens_out   bigint NOT NULL DEFAULT 0,
  requests     int    NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workspace_id, period_start)
);
CREATE INDEX IF NOT EXISTS idx_token_usage_user ON token_usage(user_id, period_start DESC);
