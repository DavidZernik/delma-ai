-- When the overnight critic flags a "missed" or "wrong" item, file a
-- candidate eval-case row here for human review. The eval suite grows
-- automatically from real failures we saw in production / narratives.

CREATE TABLE IF NOT EXISTS quality_candidate_evals (
  id bigserial PRIMARY KEY,
  found_at timestamptz NOT NULL DEFAULT now(),
  source_simulation_id bigint REFERENCES quality_simulations(id) ON DELETE SET NULL,
  source_observation_id bigint REFERENCES quality_observations(id) ON DELETE SET NULL,
  category text NOT NULL,                  -- 'missed' | 'wrong'
  finding_text text NOT NULL,              -- the critic's note
  suggested_input text,                    -- the user input that should have triggered the right behavior
  expected_op text,                        -- e.g. 'add_decision' (best-effort guess)
  expected_tab text,                       -- e.g. 'memory:decisions.md'
  status text NOT NULL DEFAULT 'pending',  -- 'pending' | 'accepted' | 'rejected' | 'duplicate'
  reviewed_at timestamptz,
  notes text
);
CREATE INDEX IF NOT EXISTS idx_quality_candidate_evals_status ON quality_candidate_evals(status, found_at DESC);
