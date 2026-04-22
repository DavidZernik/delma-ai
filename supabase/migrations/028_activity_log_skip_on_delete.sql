-- Activity-log triggers on memory_notes / org_memory_notes / diagram_views
-- fire on every I/U/D. During a project DELETE, Postgres cascades into those
-- child tables, and the triggers try to INSERT new activity_log rows that
-- reference the project being deleted — which violates the FK and blocks
-- the whole delete:
--
--   "insert or update on table \"activity_log\" violates foreign key
--    constraint \"activity_log_workspace_id_fkey\""
--
-- Fix: skip the activity_log INSERT on DELETE operations. The audit trail
-- for child deletions is implicit in the parent delete (cascaded away),
-- and we never needed a separate row for "Deleted diagram X" anyway —
-- no one reads those entries, they're always paired with a parent delete.
-- INSERT and UPDATE logging still fires so Claude's edits stay visible
-- in the activity feed.

CREATE OR REPLACE FUNCTION _activity_log_memory_notes() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := COALESCE(NEW.owner_id, OLD.owner_id);
  v_action text;
  v_target text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;  -- skip logging on delete (see file header)
  END IF;
  IF TG_OP = 'INSERT' THEN v_action := 'insert';
  ELSE v_action := 'update'; END IF;
  v_target := COALESCE(NEW.filename, OLD.filename);

  INSERT INTO activity_log (project_id, actor_id, actor_email, kind, action, target_key, target_title, summary)
  VALUES (
    COALESCE(NEW.project_id, OLD.project_id),
    v_actor,
    _activity_log_actor_email(v_actor),
    'memory_notes',
    v_action,
    v_target,
    v_target,
    CASE v_action
      WHEN 'insert' THEN 'Created ' || v_target
      ELSE 'Updated ' || v_target
    END
  );
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION _activity_log_org_memory_notes() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := COALESCE(NEW.owner_id, OLD.owner_id);
  v_action text;
  v_target text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN v_action := 'insert';
  ELSE v_action := 'update'; END IF;
  v_target := COALESCE(NEW.filename, OLD.filename);

  INSERT INTO activity_log (org_id, actor_id, actor_email, kind, action, target_key, target_title, summary)
  VALUES (
    COALESCE(NEW.org_id, OLD.org_id),
    v_actor,
    _activity_log_actor_email(v_actor),
    'org_memory_notes',
    v_action,
    v_target,
    v_target,
    CASE v_action
      WHEN 'insert' THEN 'Created ' || v_target
      ELSE 'Updated ' || v_target
    END
  );
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION _activity_log_diagram_views() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := COALESCE(NEW.owner_id, OLD.owner_id);
  v_action text;
  v_key text;
  v_title text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN v_action := 'insert';
  ELSE v_action := 'update'; END IF;
  v_key := COALESCE(NEW.view_key, OLD.view_key);
  v_title := COALESCE(NEW.title, OLD.title);

  INSERT INTO activity_log (project_id, actor_id, actor_email, kind, action, target_key, target_title, summary)
  VALUES (
    COALESCE(NEW.project_id, OLD.project_id),
    v_actor,
    _activity_log_actor_email(v_actor),
    'diagram_views',
    v_action,
    v_key,
    v_title,
    CASE v_action
      WHEN 'insert' THEN 'Created diagram: ' || v_title
      ELSE 'Updated diagram: ' || v_title
    END
  );
  RETURN COALESCE(NEW, OLD);
END $$;
