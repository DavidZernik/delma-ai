-- Group quality-lab activity into discrete "runs" so the /logs page can
-- show one clickable card per run instead of one big mixed stream.
--
-- Before: sims, candidate_evals, eval_runs, state_checks, and signals were
-- all independent rows with only timestamps to correlate them. Figuring out
-- "what did my smoke run just do" meant squinting at timestamps.
--
-- After: each smoke/overnight fire creates a quality_runs row first, then
-- tags every child row with that run_id. The /logs landing page renders a
-- list of runs (each with a plain-English Sonnet summary of what to act on),
-- and clicking a run opens /logs/run/:id with only that run's details.

CREATE TABLE IF NOT EXISTS quality_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  trigger          text NOT NULL,            -- 'smoke' | 'smoke-medium' | 'overnight-manual' | 'overnight-scheduled'
  label            text,                     -- human-readable ("smoke --medium", "nightly 00:00 PT", etc.)
  narratives_run   text[]     DEFAULT '{}',
  num_narratives   int        DEFAULT 0,
  num_complete     int        DEFAULT 0,
  overall_score    numeric(3,2),
  min_score        int,
  max_score        int,
  num_candidates   int        DEFAULT 0,
  num_regression_fails int    DEFAULT 0,
  num_state_warnings   int    DEFAULT 0,
  ran_regression   boolean    DEFAULT false,
  ran_hygiene      boolean    DEFAULT false,
  ran_signals      boolean    DEFAULT false,
  summary          text,                     -- Sonnet-generated "what to act on"
  status           text NOT NULL DEFAULT 'running'  -- 'running' | 'complete' | 'failed'
);

CREATE INDEX IF NOT EXISTS idx_quality_runs_started_at ON quality_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_quality_runs_status     ON quality_runs(status);

-- Child rows get a nullable run_id. Existing rows stay null (they pre-date
-- this change); the UI falls back to "no run" sectioning for those.
ALTER TABLE quality_simulations      ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES quality_runs(id) ON DELETE SET NULL;
ALTER TABLE quality_candidate_evals  ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES quality_runs(id) ON DELETE SET NULL;
ALTER TABLE quality_eval_runs        ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES quality_runs(id) ON DELETE SET NULL;
ALTER TABLE quality_state_checks     ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES quality_runs(id) ON DELETE SET NULL;
ALTER TABLE quality_signals          ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES quality_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_quality_sims_run_id       ON quality_simulations(run_id);
CREATE INDEX IF NOT EXISTS idx_quality_candidates_run_id ON quality_candidate_evals(run_id);
CREATE INDEX IF NOT EXISTS idx_quality_evals_run_id      ON quality_eval_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_quality_state_run_id      ON quality_state_checks(run_id);
CREATE INDEX IF NOT EXISTS idx_quality_signals_run_id    ON quality_signals(run_id);
