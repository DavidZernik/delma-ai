-- Delma v2.1: Tab-level permissions
-- Adds granular access control to diagram views and memory notes.
--
-- Permission levels:
--   'private'     — only the owner can see and edit
--   'view-all'    — all workspace members can see, only owner can edit
--   'edit-all'    — all workspace members can see and edit
--   'view-admins' — only owners/admins can see and edit (hidden from regular members)
--
-- The 'role' column on workspace_members determines admin status:
--   'owner' = admin (full access to everything)
--   'member' = regular user (respects permission levels)

-- ── Add permission column to diagram_views ───────────────────────────────────
ALTER TABLE diagram_views
  ADD COLUMN IF NOT EXISTS permission text NOT NULL DEFAULT 'edit-all'
  CHECK (permission IN ('private', 'view-all', 'edit-all', 'view-admins'));

-- ── Add permission column to memory_notes ────────────────────────────────────
ALTER TABLE memory_notes
  ADD COLUMN IF NOT EXISTS permission text NOT NULL DEFAULT 'edit-all'
  CHECK (permission IN ('private', 'view-all', 'edit-all', 'view-admins'));

-- ── Drop old RLS policies ────────────────────────────────────────────────────
-- Replace with permission-aware policies.

DROP POLICY IF EXISTS "Members can view shared diagrams" ON diagram_views;
DROP POLICY IF EXISTS "Members can insert diagrams" ON diagram_views;
DROP POLICY IF EXISTS "Members can update shared, owners can update private" ON diagram_views;

DROP POLICY IF EXISTS "Members can view shared notes" ON memory_notes;
DROP POLICY IF EXISTS "Members can insert notes" ON memory_notes;
DROP POLICY IF EXISTS "Members can update accessible notes" ON memory_notes;

-- ── New RLS policies for diagram_views ───────────────────────────────────────

-- SELECT: who can see a diagram?
--   private      → only owner
--   view-all     → all members
--   edit-all     → all members
--   view-admins  → only owners (admin role)
CREATE POLICY "Permission-aware view diagrams" ON diagram_views
  FOR SELECT USING (
    workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid())
    AND (
      permission = 'edit-all'
      OR permission = 'view-all'
      OR (permission = 'private' AND owner_id = auth.uid())
      OR (permission = 'view-admins' AND workspace_id IN (
        SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid() AND role = 'owner'
      ))
    )
  );

-- INSERT: any member can create diagrams in their workspace
CREATE POLICY "Members can create diagrams" ON diagram_views
  FOR INSERT WITH CHECK (
    workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid())
  );

-- UPDATE: who can edit a diagram?
--   private      → only owner
--   view-all     → only owner (everyone else is read-only)
--   edit-all     → all members
--   view-admins  → only owners (admin role)
CREATE POLICY "Permission-aware edit diagrams" ON diagram_views
  FOR UPDATE USING (
    workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid())
    AND (
      permission = 'edit-all'
      OR (permission IN ('private', 'view-all') AND owner_id = auth.uid())
      OR (permission = 'view-admins' AND workspace_id IN (
        SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid() AND role = 'owner'
      ))
    )
  );

-- ── New RLS policies for memory_notes ────────────────────────────────────────

-- SELECT: same logic as diagram_views
CREATE POLICY "Permission-aware view notes" ON memory_notes
  FOR SELECT USING (
    workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid())
    AND (
      permission = 'edit-all'
      OR permission = 'view-all'
      OR (permission = 'private' AND owner_id = auth.uid())
      OR (permission = 'view-admins' AND workspace_id IN (
        SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid() AND role = 'owner'
      ))
    )
  );

-- INSERT: any member can create notes
CREATE POLICY "Members can create notes" ON memory_notes
  FOR INSERT WITH CHECK (
    workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid())
  );

-- UPDATE: same edit logic as diagram_views
CREATE POLICY "Permission-aware edit notes" ON memory_notes
  FOR UPDATE USING (
    workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid())
    AND (
      permission = 'edit-all'
      OR (permission IN ('private', 'view-all') AND owner_id = auth.uid())
      OR (permission = 'view-admins' AND workspace_id IN (
        SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid() AND role = 'owner'
      ))
    )
  );

-- ── Update existing data with sensible defaults ─────────────────────────────
-- Architecture and Campaign Logic: everyone can see, only admins edit
UPDATE diagram_views SET permission = 'view-all' WHERE view_key = 'architecture';
UPDATE memory_notes SET permission = 'view-all' WHERE filename = 'logic.md';

-- People: everyone can see and edit (corrections welcome from anyone)
UPDATE memory_notes SET permission = 'edit-all' WHERE filename = 'people.md';

-- Environment: only admins (has API keys and sensitive IDs)
UPDATE memory_notes SET permission = 'view-admins' WHERE filename = 'environment.md';

-- Session Log: private per user
UPDATE memory_notes SET permission = 'private' WHERE filename = 'session-log.md';
