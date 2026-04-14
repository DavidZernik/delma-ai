-- Delma v2.2: Organizations
-- ──────────────────────────────────────────────────────────────────────────────
--
-- Adds an organization layer above workspaces.
-- People belong to orgs. Workspaces belong to orgs.
-- A user sees workspaces from their org(s).
--
-- Hierarchy:
--   Organization (e.g. "Emory Healthcare")
--     └── Workspace (e.g. "Birthday Campaign")
--           └── Tabs (Architecture, People, Environment, etc.)
--
-- Org roles:
--   'admin'  — can create workspaces, manage members, see everything
--   'member' — can access workspaces they're added to
--

-- ── Organizations table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,  -- URL-friendly name (e.g. "emory")
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

-- ── Org membership ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_members (
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  joined_at timestamptz DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

-- ── Link workspaces to orgs ──────────────────────────────────────────────────
-- Every workspace belongs to an org. Users see workspaces from orgs they're in.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id) ON DELETE CASCADE;

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_org ON workspaces(org_id);

-- ── RLS on organizations ─────────────────────────────────────────────────────
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;

-- Org members can see their orgs
CREATE POLICY "Members can view their orgs" ON organizations
  FOR SELECT USING (
    id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

-- Authenticated users can create orgs
CREATE POLICY "Authenticated users can create orgs" ON organizations
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Users can see their own org memberships
CREATE POLICY "Users can view own org memberships" ON org_members
  FOR SELECT USING (user_id = auth.uid());

-- Users can add themselves (when creating an org)
CREATE POLICY "Users can add themselves to orgs" ON org_members
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- Admins can manage org members
CREATE POLICY "Admins can manage org members" ON org_members
  FOR ALL USING (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid() AND role = 'admin')
  );

-- ── Update workspace RLS to include org membership ───────────────────────────
-- Users can see workspaces if:
--   1. They're a direct workspace member (existing behavior), OR
--   2. They're an admin of the workspace's org
DROP POLICY IF EXISTS "Members can view workspaces" ON workspaces;
CREATE POLICY "Members can view workspaces" ON workspaces
  FOR SELECT USING (
    id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid())
    OR org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid() AND role = 'admin')
  );

-- Org members can create workspaces in their org
DROP POLICY IF EXISTS "Authenticated users can create workspaces" ON workspaces;
CREATE POLICY "Org members can create workspaces" ON workspaces
  FOR INSERT WITH CHECK (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );
