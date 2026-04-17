-- Schema rename: "workspace" → "project" across the whole database.
--
-- Product-level we've always called them projects; the schema was the only
-- place that said "workspace". This migration unifies the vocabulary.
--
-- Postgres renames propagate through RLS policies, foreign keys, and views
-- automatically (references are stored by OID, not by name), so this is
-- safe to run as one atomic step.

BEGIN;

-- 1. Rename the tables.
ALTER TABLE workspaces RENAME TO projects;
ALTER TABLE workspace_members RENAME TO project_members;

-- 2. Rename the FK column in every table that references projects (formerly workspaces).
ALTER TABLE activity_log         RENAME COLUMN workspace_id TO project_id;
ALTER TABLE api_op_logs          RENAME COLUMN workspace_id TO project_id;
ALTER TABLE conversation_ticks   RENAME COLUMN workspace_id TO project_id;
ALTER TABLE conversations        RENAME COLUMN workspace_id TO project_id;
ALTER TABLE diagram_views        RENAME COLUMN workspace_id TO project_id;
ALTER TABLE history_snapshots    RENAME COLUMN workspace_id TO project_id;
ALTER TABLE mcp_call_logs        RENAME COLUMN workspace_id TO project_id;
ALTER TABLE memory_notes         RENAME COLUMN workspace_id TO project_id;
ALTER TABLE project_members      RENAME COLUMN workspace_id TO project_id;
ALTER TABLE quality_router_calls RENAME COLUMN workspace_id TO project_id;
ALTER TABLE quality_simulations  RENAME COLUMN workspace_id TO project_id;
ALTER TABLE quality_state_checks RENAME COLUMN workspace_id TO project_id;
ALTER TABLE token_usage          RENAME COLUMN workspace_id TO project_id;

-- 3. org_members tracks which project the user currently has open.
ALTER TABLE org_members RENAME COLUMN active_workspace_id TO active_project_id;

COMMIT;
