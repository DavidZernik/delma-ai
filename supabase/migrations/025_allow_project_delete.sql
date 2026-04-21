-- Allow project owners to delete their project.
--
-- Until now there was no DELETE policy on `projects`, so every delete was
-- silently blocked by RLS (0 rows affected, no error — user sees nothing
-- happen). This migration adds a DELETE policy that lets any project member
-- with role='owner' delete the project. Cascades already wired in the
-- original schema handle project_members, diagram_views, memory_notes,
-- history_snapshots, activity_log, project_app_permissions, etc.
--
-- Also add a matching UPDATE policy so owners can rename their projects.

CREATE POLICY "Owners can delete projects" ON projects
  FOR DELETE USING (
    id IN (
      SELECT project_id FROM project_members
      WHERE user_id = auth.uid() AND role = 'owner'
    )
  );

CREATE POLICY "Owners can update projects" ON projects
  FOR UPDATE USING (
    id IN (
      SELECT project_id FROM project_members
      WHERE user_id = auth.uid() AND role = 'owner'
    )
  );
