-- Make `org_members.active_project_id` null-out on project delete instead
-- of blocking the delete. Without this, trying to delete a project that any
-- org member has as their active project fails with:
--   "update or delete on table \"projects\" violates foreign key constraint
--    \"org_members_active_workspace_id_fkey\" on table \"org_members\""
--
-- The FK was created back in migration 004 (when projects were still called
-- workspaces) without an ON DELETE clause, so it defaulted to NO ACTION.

ALTER TABLE org_members
  DROP CONSTRAINT IF EXISTS org_members_active_workspace_id_fkey;

ALTER TABLE org_members
  DROP CONSTRAINT IF EXISTS org_members_active_project_id_fkey;

ALTER TABLE org_members
  ADD CONSTRAINT org_members_active_project_id_fkey
  FOREIGN KEY (active_project_id) REFERENCES projects(id) ON DELETE SET NULL;
