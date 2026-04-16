-- Add structured jsonb column to memory tabs so they can be stored as data
-- instead of raw markdown. Legacy `content` stays as the rendered view. When
-- `structured` is NULL, the tab is in legacy (free-form markdown) mode.

ALTER TABLE memory_notes
  ADD COLUMN IF NOT EXISTS structured jsonb;

ALTER TABLE org_memory_notes
  ADD COLUMN IF NOT EXISTS structured jsonb;

CREATE INDEX IF NOT EXISTS idx_memory_notes_structured
  ON memory_notes USING gin (structured);

CREATE INDEX IF NOT EXISTS idx_org_memory_notes_structured
  ON org_memory_notes USING gin (structured);
