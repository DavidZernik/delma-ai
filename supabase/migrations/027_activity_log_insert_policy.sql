-- Triggers insert into activity_log whenever diagram_views / memory_notes /
-- etc. change. Those inserts were failing under RLS because activity_log
-- has SELECT policies but no INSERT policy — so any client-side write
-- (e.g. creating a new project and seeding its diagram/memory tabs) fails
-- with "new row violates row-level security policy for table activity_log".
--
-- This migration lets authenticated members insert activity rows for
-- projects or orgs they belong to. Triggers run as the invoker by default,
-- so they inherit the caller's auth context and check against this policy.

CREATE POLICY activity_log_insert_project ON activity_log
  FOR INSERT WITH CHECK (
    project_id IS NULL OR EXISTS (
      SELECT 1 FROM project_members pm
      WHERE pm.project_id = activity_log.project_id
        AND pm.user_id = auth.uid()
    )
  );

CREATE POLICY activity_log_insert_org ON activity_log
  FOR INSERT WITH CHECK (
    org_id IS NULL OR EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.org_id = activity_log.org_id
        AND om.user_id = auth.uid()
    )
  );
