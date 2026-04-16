-- Overnight end-to-end simulations: one comprehensive test per night.
-- Mocks a multi-turn Claude Code conversation, watches Delma respond, and
-- has a Sonnet critic grade the final state.

CREATE TABLE IF NOT EXISTS quality_simulations (
  id bigserial PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(),
  workspace_id uuid,
  transcript jsonb NOT NULL,
  ops_applied jsonb NOT NULL,
  final_state jsonb NOT NULL,
  critique jsonb NOT NULL,
  overall_score int,
  total_duration_ms int
);
CREATE INDEX IF NOT EXISTS idx_quality_simulations_ran_at ON quality_simulations(ran_at DESC);
