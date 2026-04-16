-- Per-simulation fidelity score — a deterministic "did we capture what the
-- user told us?" metric, separate from the Sonnet critic's judgmental
-- quality score.
--
-- Why two signals: the critic's 1-5 score swings ±1 across runs of the same
-- narrative (LLM variance). Fidelity uses embedding-based matching of each
-- narrative's expected-outcome prose against the final structured state —
-- reproducible, stable, and tells us whether the underlying capture changed.
-- Together they separate "LLM had a bad day" from "real regression."

ALTER TABLE quality_simulations
  ADD COLUMN IF NOT EXISTS fidelity_score numeric(4,1),   -- 0-100 (%)
  ADD COLUMN IF NOT EXISTS fidelity_detail jsonb;         -- per-tab breakdown, missed items, forbidden hits

-- Same for quality_runs aggregates.
ALTER TABLE quality_runs
  ADD COLUMN IF NOT EXISTS avg_fidelity numeric(4,1),
  ADD COLUMN IF NOT EXISTS min_fidelity numeric(4,1),
  ADD COLUMN IF NOT EXISTS max_fidelity numeric(4,1);
