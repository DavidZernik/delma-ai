-- Fix activity_log triggers: they were written before migration 019 renamed
-- workspace_id → project_id on every table, so the PL/pgSQL bodies still
-- reference NEW.workspace_id and the `workspace_id` column in INSERT. Redefine
-- the three functions against the current schema.

CREATE OR REPLACE FUNCTION _activity_log_memory_notes() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := COALESCE(NEW.owner_id, OLD.owner_id);
  v_action text;
  v_target text;
BEGIN
  IF TG_OP = 'INSERT' THEN v_action := 'insert';
  ELSIF TG_OP = 'DELETE' THEN v_action := 'delete';
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
      WHEN 'delete' THEN 'Deleted ' || v_target
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
  IF TG_OP = 'INSERT' THEN v_action := 'insert';
  ELSIF TG_OP = 'DELETE' THEN v_action := 'delete';
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
      WHEN 'delete' THEN 'Deleted ' || v_target
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
  IF TG_OP = 'INSERT' THEN v_action := 'insert';
  ELSIF TG_OP = 'DELETE' THEN v_action := 'delete';
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
      WHEN 'delete' THEN 'Deleted diagram: ' || v_title
      ELSE 'Updated diagram: ' || v_title
    END
  );
  RETURN COALESCE(NEW, OLD);
END $$;

-- Also fix the RLS policy on activity_log — it filtered on workspace_id too.
DROP POLICY IF EXISTS activity_log_read_workspace ON activity_log;
CREATE POLICY activity_log_read_project ON activity_log
  FOR SELECT USING (
    project_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM project_members pm
      WHERE pm.project_id = activity_log.project_id
        AND pm.user_id = auth.uid()
    )
  );
