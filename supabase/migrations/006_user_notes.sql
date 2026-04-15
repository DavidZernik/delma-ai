-- Per-user global notes. One row per user, follows them across all orgs/projects.

CREATE TABLE IF NOT EXISTS user_notes (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  content text DEFAULT '',
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE user_notes ENABLE ROW LEVEL SECURITY;

-- Users can only read/write their OWN notes
CREATE POLICY "Users read own notes" ON user_notes FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users insert own notes" ON user_notes FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users update own notes" ON user_notes FOR UPDATE USING (user_id = auth.uid());

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE user_notes;
