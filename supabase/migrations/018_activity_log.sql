-- Activity log — the "History" feed for a project.
--
-- Every change to a memory tab or diagram view is recorded here, so the
-- UI can show users what happened when and who did it. Writes happen via
-- Postgres triggers so client and server paths are both covered.

CREATE TABLE IF NOT EXISTS activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id),
  actor_email text,
  kind text NOT NULL,          -- 'memory_notes' | 'org_memory_notes' | 'diagram_views'
  action text NOT NULL,        -- 'insert' | 'update' | 'delete'
  target_key text,             -- filename for notes, view_key for diagrams
  target_title text,           -- human-readable label at time of change
  summary text,                -- one-line description of what changed
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS activity_log_workspace_idx ON activity_log (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_log_org_idx ON activity_log (org_id, created_at DESC);

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

-- Read: workspace members read workspace rows; org members read org rows.
CREATE POLICY activity_log_read_workspace ON activity_log
  FOR SELECT USING (
    workspace_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM workspace_members wm
      WHERE wm.workspace_id = activity_log.workspace_id
        AND wm.user_id = auth.uid()
    )
  );

CREATE POLICY activity_log_read_org ON activity_log
  FOR SELECT USING (
    org_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.org_id = activity_log.org_id
        AND om.user_id = auth.uid()
    )
  );

-- Writes go through service-role only (triggers + server). Clients never insert.
-- No insert/update/delete policies for authenticated role → blocked by default.

-- Helper: resolve an actor_email from auth.users. Used in triggers.
CREATE OR REPLACE FUNCTION _activity_log_actor_email(uid uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT email FROM auth.users WHERE id = uid
$$;

-- Trigger on memory_notes (project-level).
CREATE OR REPLACE FUNCTION _activity_log_memory_notes() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid := COALESCE(NEW.owner_id, OLD.owner_id);
  v_action text;
  v_target text;
  v_summary text;
BEGIN
  IF TG_OP = 'INSERT' THEN v_action := 'insert';
  ELSIF TG_OP = 'DELETE' THEN v_action := 'delete';
  ELSE v_action := 'update'; END IF;

  v_target := COALESCE(NEW.filename, OLD.filename);
  v_summary := CASE v_action
    WHEN 'insert' THEN 'Created ' || v_target
    WHEN 'delete' THEN 'Deleted ' || v_target
    ELSE 'Updated ' || v_target
  END;

  INSERT INTO activity_log (workspace_id, actor_id, actor_email, kind, action, target_key, target_title, summary)
  VALUES (
    COALESCE(NEW.workspace_id, OLD.workspace_id),
    v_actor,
    _activity_log_actor_email(v_actor),
    'memory_notes',
    v_action,
    v_target,
    v_target,
    v_summary
  );
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS memory_notes_activity ON memory_notes;
CREATE TRIGGER memory_notes_activity
AFTER INSERT OR UPDATE OR DELETE ON memory_notes
FOR EACH ROW EXECUTE FUNCTION _activity_log_memory_notes();

-- Trigger on org_memory_notes (org-level).
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

DROP TRIGGER IF EXISTS org_memory_notes_activity ON org_memory_notes;
CREATE TRIGGER org_memory_notes_activity
AFTER INSERT OR UPDATE OR DELETE ON org_memory_notes
FOR EACH ROW EXECUTE FUNCTION _activity_log_org_memory_notes();

-- Trigger on diagram_views.
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

  INSERT INTO activity_log (workspace_id, actor_id, actor_email, kind, action, target_key, target_title, summary)
  VALUES (
    COALESCE(NEW.workspace_id, OLD.workspace_id),
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

DROP TRIGGER IF EXISTS diagram_views_activity ON diagram_views;
CREATE TRIGGER diagram_views_activity
AFTER INSERT OR UPDATE OR DELETE ON diagram_views
FOR EACH ROW EXECUTE FUNCTION _activity_log_diagram_views();

-- Realtime: publish inserts so the UI can tail the feed live.
ALTER PUBLICATION supabase_realtime ADD TABLE activity_log;
