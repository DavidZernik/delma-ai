-- Architecture diagrams move to structured ops (same pattern as memory tabs).
-- The legacy `mermaid` column stays as the rendered view; `structured` becomes
-- the source of truth (nodes, edges, layers, prose).

ALTER TABLE diagram_views
  ADD COLUMN IF NOT EXISTS structured jsonb;

CREATE INDEX IF NOT EXISTS idx_diagram_views_structured
  ON diagram_views USING gin (structured);
