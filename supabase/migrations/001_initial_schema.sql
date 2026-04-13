-- Delma v2: Supabase Schema
-- Run this in your Supabase SQL Editor (https://supabase.com/dashboard/project/qefonivgcpxkpbimnqef/sql)

-- ── Workspaces ───────────────────────────────────────────────────────────────
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

create table workspace_members (
  workspace_id uuid references workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz default now(),
  primary key (workspace_id, user_id)
);

-- ── Diagram Views ────────────────────────────────────────────────────────────
-- Each workspace has multiple diagram views (Architecture, Org Chart, custom).
-- visibility: 'shared' = all workspace members see it, 'private' = only owner.
create table diagram_views (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade not null,
  view_key text not null,
  title text not null,
  kind text,
  description text default '',
  summary text default '',
  mermaid text default '',
  visibility text not null default 'shared' check (visibility in ('shared', 'private')),
  owner_id uuid references auth.users(id),
  updated_at timestamptz default now(),
  unique(workspace_id, view_key, owner_id)
);

-- ── Memory Notes ─────────────────────────────────────────────────────────────
-- Structured markdown files: environment.md, logic.md, people.md, session-log.md.
-- session-log.md is private per user; the rest are shared.
create table memory_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade not null,
  filename text not null,
  content text default '',
  visibility text not null default 'shared' check (visibility in ('shared', 'private')),
  owner_id uuid references auth.users(id),
  updated_at timestamptz default now(),
  unique(workspace_id, filename, owner_id)
);

-- ── History Snapshots ────────────────────────────────────────────────────────
create table history_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade not null,
  reason text default 'workspace-save',
  snapshot jsonb not null,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- ── MCP Call Logs ────────────────────────────────────────────────────────────
-- Raw material for the analyzer app.
create table mcp_call_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  user_id uuid,
  tool text not null,
  input jsonb,
  duration_ms integer,
  success boolean default true,
  error text,
  created_at timestamptz default now()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
create index idx_diagram_views_workspace on diagram_views(workspace_id);
create index idx_memory_notes_workspace on memory_notes(workspace_id);
create index idx_history_workspace on history_snapshots(workspace_id, created_at desc);
create index idx_mcp_logs_workspace on mcp_call_logs(workspace_id, created_at desc);

-- ── Row Level Security ───────────────────────────────────────────────────────

alter table workspaces enable row level security;
alter table workspace_members enable row level security;
alter table diagram_views enable row level security;
alter table memory_notes enable row level security;
alter table history_snapshots enable row level security;
alter table mcp_call_logs enable row level security;

-- Workspaces: members can see their workspaces
create policy "Members can view workspaces" on workspaces
  for select using (
    id in (select workspace_id from workspace_members where user_id = auth.uid())
  );

create policy "Authenticated users can create workspaces" on workspaces
  for insert with check (auth.uid() is not null);

-- Workspace members: members can see other members
create policy "Members can view membership" on workspace_members
  for select using (
    workspace_id in (select workspace_id from workspace_members where user_id = auth.uid())
  );

create policy "Owners can manage members" on workspace_members
  for all using (
    workspace_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid() and role = 'owner'
    )
  );

-- Allow self-insert when creating workspace
create policy "Users can add themselves" on workspace_members
  for insert with check (user_id = auth.uid());

-- Diagram views: shared views visible to all members, private only to owner
create policy "Members can view shared diagrams" on diagram_views
  for select using (
    workspace_id in (select workspace_id from workspace_members where user_id = auth.uid())
    and (visibility = 'shared' or owner_id = auth.uid())
  );

create policy "Members can insert diagrams" on diagram_views
  for insert with check (
    workspace_id in (select workspace_id from workspace_members where user_id = auth.uid())
  );

create policy "Members can update shared, owners can update private" on diagram_views
  for update using (
    workspace_id in (select workspace_id from workspace_members where user_id = auth.uid())
    and (visibility = 'shared' or owner_id = auth.uid())
  );

-- Memory notes: same pattern as diagram views
create policy "Members can view shared notes" on memory_notes
  for select using (
    workspace_id in (select workspace_id from workspace_members where user_id = auth.uid())
    and (visibility = 'shared' or owner_id = auth.uid())
  );

create policy "Members can insert notes" on memory_notes
  for insert with check (
    workspace_id in (select workspace_id from workspace_members where user_id = auth.uid())
  );

create policy "Members can update accessible notes" on memory_notes
  for update using (
    workspace_id in (select workspace_id from workspace_members where user_id = auth.uid())
    and (visibility = 'shared' or owner_id = auth.uid())
  );

-- History: members can view and insert
create policy "Members can view history" on history_snapshots
  for select using (
    workspace_id in (select workspace_id from workspace_members where user_id = auth.uid())
  );

create policy "Members can create history" on history_snapshots
  for insert with check (
    workspace_id in (select workspace_id from workspace_members where user_id = auth.uid())
  );

-- MCP logs: members can view, anyone can insert (service role key used by MCP)
create policy "Members can view logs" on mcp_call_logs
  for select using (
    workspace_id in (select workspace_id from workspace_members where user_id = auth.uid())
  );

create policy "Service can insert logs" on mcp_call_logs
  for insert with check (true);

-- ── Enable Realtime ──────────────────────────────────────────────────────────
-- These two tables push live updates to the web app via Supabase Realtime.
alter publication supabase_realtime add table diagram_views;
alter publication supabase_realtime add table memory_notes;

-- ── Auto-update timestamp trigger ────────────────────────────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger set_updated_at before update on diagram_views
  for each row execute function update_updated_at();

create trigger set_updated_at before update on memory_notes
  for each row execute function update_updated_at();
