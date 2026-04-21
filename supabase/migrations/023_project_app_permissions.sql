-- Per-project permission level for each connected integration (app).
-- An app connection (e.g. SFMC) is stored once per org in sfmc_accounts,
-- but Delma's write access to that app is decided per-project. Users who
-- want Delma to operate read-only on the Birthday Campaign project can
-- leave it on read_only here, while allowing read_write on a different
-- project that's actively being built.
--
-- app_id is a text slug (e.g. 'sfmc') rather than a FK, so we can add new
-- integrations without a schema change each time.

CREATE TABLE IF NOT EXISTS project_app_permissions (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'read_only'
    CHECK (permission IN ('read_only', 'read_write')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  PRIMARY KEY (project_id, app_id)
);

CREATE INDEX IF NOT EXISTS idx_project_app_permissions_project
  ON project_app_permissions(project_id);
