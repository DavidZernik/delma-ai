-- Delma Quality Lab — observability + critique tables.
-- Read-only by the live system; written by the quality runner that fires
-- on a schedule. All visible at /logs (public, no auth — internal use only).

-- Production logging: every router decision and every typed-op application.
-- We already have mcp_call_logs; add the equivalent for the web side.
CREATE TABLE IF NOT EXISTS api_op_logs (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  workspace_id uuid,
  org_id uuid,
  tab_key text NOT NULL,
  ops jsonb NOT NULL,
  applied_count int,
  error_count int,
  duration_ms int,
  success boolean NOT NULL,
  error text
);
CREATE INDEX IF NOT EXISTS idx_api_op_logs_created_at ON api_op_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS quality_router_calls (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  workspace_id uuid,
  input text NOT NULL,
  ops jsonb NOT NULL,
  raw_response text,
  model text,
  duration_ms int
);
CREATE INDEX IF NOT EXISTS idx_quality_router_calls_created_at ON quality_router_calls(created_at DESC);

-- Layer 1: regression eval results
CREATE TABLE IF NOT EXISTS quality_eval_runs (
  id bigserial PRIMARY KEY,
  run_at timestamptz NOT NULL DEFAULT now(),
  case_name text NOT NULL,
  pass boolean NOT NULL,
  ms int,
  ops_emitted jsonb,
  raw_response text,
  failure_reasons text[],
  model text
);
CREATE INDEX IF NOT EXISTS idx_quality_eval_runs_run_at ON quality_eval_runs(run_at DESC);

-- Layer 2: critic observations on real production calls
CREATE TABLE IF NOT EXISTS quality_observations (
  id bigserial PRIMARY KEY,
  observed_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,            -- 'mcp' | 'api_op' | 'router'
  source_id text,                  -- id of the original call log row
  severity text NOT NULL,          -- 'clean' | 'minor' | 'suspicious' | 'wrong'
  score int,                       -- 1-5
  finding text NOT NULL,
  suggestion text,
  reviewed boolean NOT NULL DEFAULT false,
  context jsonb                    -- the call payload + state diff for triage
);
CREATE INDEX IF NOT EXISTS idx_quality_observations_observed_at ON quality_observations(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_quality_observations_severity ON quality_observations(severity) WHERE severity IN ('suspicious', 'wrong');

-- Layer 3: data-hygiene findings (no LLM, just SQL sanity)
CREATE TABLE IF NOT EXISTS quality_state_checks (
  id bigserial PRIMARY KEY,
  checked_at timestamptz NOT NULL DEFAULT now(),
  org_id uuid,
  workspace_id uuid,
  check_name text NOT NULL,        -- 'orphan_node' | 'overdue_action' | 'unowned_decision' | ...
  severity text NOT NULL,          -- 'info' | 'warn'
  detail text NOT NULL,
  ref jsonb                        -- pointers into the offending row(s)
);
CREATE INDEX IF NOT EXISTS idx_quality_state_checks_checked_at ON quality_state_checks(checked_at DESC);

-- Layer 4: router signal-mining clusters (what is the LLM struggling with?)
CREATE TABLE IF NOT EXISTS quality_signals (
  id bigserial PRIMARY KEY,
  found_at timestamptz NOT NULL DEFAULT now(),
  pattern text NOT NULL,           -- short label
  count int NOT NULL,
  examples text[] NOT NULL,
  suggestion text                  -- "consider adding op X" / "tighten scope of tab Y"
);
CREATE INDEX IF NOT EXISTS idx_quality_signals_found_at ON quality_signals(found_at DESC);

-- Layer 5: A/B experiments — alternate prompts/configs scored on the eval suite
CREATE TABLE IF NOT EXISTS quality_experiments (
  id bigserial PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL,              -- experiment label
  config jsonb NOT NULL,           -- prompt hash, model, etc.
  pass_rate numeric,
  median_ms int,
  total_cases int,
  vs_baseline_delta numeric        -- pp difference vs current production
);
CREATE INDEX IF NOT EXISTS idx_quality_experiments_ran_at ON quality_experiments(ran_at DESC);

-- Single-row table to track when the quality runner last fired, per layer.
CREATE TABLE IF NOT EXISTS quality_runner_status (
  layer text PRIMARY KEY,
  last_run_at timestamptz,
  last_duration_ms int,
  last_error text
);
