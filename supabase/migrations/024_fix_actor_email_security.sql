-- Fix: every UPDATE/INSERT/DELETE on memory_notes, org_memory_notes, and
-- diagram_views fires an activity_log trigger that calls
-- `_activity_log_actor_email(uid)`, which does `SELECT email FROM auth.users`.
-- That table isn't readable by the anon / service roles the server uses, so
-- the trigger fails with: permission denied for table users. The trigger
-- then aborts the whole statement, which is why users hit "permission denied
-- for table users" when they tried to delete a decision or person.
--
-- Marking the helper SECURITY DEFINER makes it run with the function owner's
-- privileges (typically postgres / supabase_admin, who CAN read auth.users),
-- while the calling context (the trigger, the user's UPDATE) stays as-is.
-- Also pin search_path so a malicious schema can't shadow auth.users.

CREATE OR REPLACE FUNCTION _activity_log_actor_email(uid uuid) RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE AS $$
  SELECT email FROM auth.users WHERE id = uid
$$;
