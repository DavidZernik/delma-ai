-- 029_local_first_reset.sql
--
-- Wipe every table from the cloud-app era. Delma is now local-first: project
-- state lives in the user's CLAUDE.md, SFMC creds live in their ~/.config,
-- chat history lives in their project's .delma folder. Nothing belongs in
-- Postgres anymore EXCEPT identity (Supabase Auth) and the per-user usage
-- log that backstops the Anthropic proxy.
--
-- Applied once to drop the legacy schema and create the new minimal one.

BEGIN;

-- Drop every leftover public table from the cloud era. CASCADE handles FKs
-- between them so the order doesn't matter.

DROP TABLE IF EXISTS public.__delma_migrations           CASCADE;
DROP TABLE IF EXISTS public.activity_log                 CASCADE;
DROP TABLE IF EXISTS public.api_op_logs                  CASCADE;
DROP TABLE IF EXISTS public.conversation_ticks           CASCADE;
DROP TABLE IF EXISTS public.conversations                CASCADE;
DROP TABLE IF EXISTS public.diagram_views                CASCADE;
DROP TABLE IF EXISTS public.history_snapshots            CASCADE;
DROP TABLE IF EXISTS public.mcp_call_logs                CASCADE;
DROP TABLE IF EXISTS public.memory_notes                 CASCADE;
DROP TABLE IF EXISTS public.messages                     CASCADE;
DROP TABLE IF EXISTS public.org_members                  CASCADE;
DROP TABLE IF EXISTS public.org_memory_notes             CASCADE;
DROP TABLE IF EXISTS public.organizations                CASCADE;
DROP TABLE IF EXISTS public.project_app_permissions      CASCADE;
DROP TABLE IF EXISTS public.project_members              CASCADE;
DROP TABLE IF EXISTS public.projects                     CASCADE;
DROP TABLE IF EXISTS public.quality_candidate_evals      CASCADE;
DROP TABLE IF EXISTS public.quality_eval_runs            CASCADE;
DROP TABLE IF EXISTS public.quality_experiments          CASCADE;
DROP TABLE IF EXISTS public.quality_observations         CASCADE;
DROP TABLE IF EXISTS public.quality_router_calls         CASCADE;
DROP TABLE IF EXISTS public.quality_runner_status        CASCADE;
DROP TABLE IF EXISTS public.quality_runs                 CASCADE;
DROP TABLE IF EXISTS public.quality_signals              CASCADE;
DROP TABLE IF EXISTS public.quality_simulations          CASCADE;
DROP TABLE IF EXISTS public.quality_state_checks         CASCADE;
DROP TABLE IF EXISTS public.sfmc_accounts                CASCADE;
DROP TABLE IF EXISTS public.sfmc_audit_log               CASCADE;
DROP TABLE IF EXISTS public.token_usage                  CASCADE;
DROP TABLE IF EXISTS public.user_notes                   CASCADE;

-- Per-user Anthropic usage log. The proxy appends one row per call so we can
-- enforce daily token caps and see who's burning budget. user_id references
-- auth.users so deletion cascades automatically.
CREATE TABLE public.usage_log (
  id            bigserial PRIMARY KEY,
  user_id       uuid          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ts            timestamptz   NOT NULL DEFAULT now(),
  endpoint      text          NOT NULL,
  model         text,
  input_tokens  integer       NOT NULL DEFAULT 0,
  output_tokens integer       NOT NULL DEFAULT 0,
  cost_usd      numeric(10,6) NOT NULL DEFAULT 0,
  status        integer       NOT NULL DEFAULT 200,
  request_id    text
);

-- Hot path: "how many tokens has this user used in the last 24h?". Index by
-- (user_id, ts DESC) so the rate-limit check is a fast range scan.
CREATE INDEX usage_log_user_ts ON public.usage_log (user_id, ts DESC);

-- Users can read their own usage. Inserts come from the proxy via the
-- service-role key, which bypasses RLS — no public insert policy needed.
ALTER TABLE public.usage_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users read own usage" ON public.usage_log
  FOR SELECT USING (auth.uid() = user_id);

COMMIT;
