# Delma Live — the product that exists now

This is the canonical reference for the product as it exists in the
repo today.

---

## 1. What Delma is

> **Delma is a visual workspace that captures project context from AI
> conversations and makes it visible, editable, and shareable — so
> non-technical people can manage technical projects through Claude Code
> without needing an engineer.**

No local repo required. Everything lives in Supabase. Claude Code
connects via MCP and reads/writes the same data the web app shows.

---

## 2. Architecture

```
Claude Code  -->  Delma MCP Server  -->  Supabase (Postgres)
                                              ^
                                              |
                                         Delma Web App
                                         (real-time subscriptions)
```

Both Claude (via MCP) and the user (via web app) write to the same
Supabase tables. Supabase Realtime pushes changes to all connected
clients instantly.

---

## 3. Tabs

Every tab is markdown. Some contain inline Mermaid diagrams. No
separate "diagram type" vs "document type" — just content.

| Tab | What it answers | Default permission |
|-----|----------------|-------------------|
| Architecture | How does the system flow? | view-all (everyone reads, admins edit) |
| Campaign Logic | What are the business rules? | view-all |
| People | Who owns what? Who decides? | edit-all (anyone can correct) |
| Environment | Where do I find this ID/URL/key? | view-admins (has API credentials) |
| Session Log | What's done? What's left? | private (per user) |

---

## 4. Tab Permissions

Each tab has a permission level that controls who can see and edit it.
This is enforced at two levels: Postgres RLS policies (hard boundary)
and UI controls (lock icons, hidden Edit buttons).

| Permission | Who sees it | Who edits it |
|-----------|-------------|-------------|
| `private` | Only the owner | Only the owner |
| `view-all` | All workspace members | Only owners/admins |
| `edit-all` | All workspace members | All workspace members |
| `view-admins` | Only owners/admins | Only owners/admins |

### Why this matters

- **Environment tab** has API keys and credentials — hidden from
  regular members by default (`view-admins`)
- **Session Log** is personal — each user has their own (`private`)
- **People** tab is open — anyone can correct who owns what (`edit-all`)
- **Architecture and Logic** are visible to everyone but only
  admins change them (`view-all`)

### Workspace roles

- `owner` — full access to everything, can manage members
- `member` — access controlled by tab permission levels

---

## 5. Supabase Backend

### Tables

| Table | Purpose |
|-------|---------|
| `workspaces` | Named workspaces (e.g. "Birthday Campaign") |
| `workspace_members` | Who belongs + role (owner/member) |
| `diagram_views` | Mermaid diagrams with title, description, summary, permission |
| `memory_notes` | Markdown documents with filename, content, permission |
| `history_snapshots` | Timestamped JSON snapshots on every save |
| `mcp_call_logs` | Every MCP tool call logged for analytics |

### Auth

Supabase Auth with email/password. First login auto-creates the account.

### Real-time

`diagram_views` and `memory_notes` have Supabase Realtime enabled.
When Claude writes via MCP, the web app updates live.

---

## 6. The MCP Server

Runs locally via `npm run start:mcp` (stdio transport).
Requires env vars: `DELMA_WORKSPACE_ID`, `DELMA_USER_ID`.

| Tool | Purpose |
|------|---------|
| `open_workspace` | Set active workspace by name or ID |
| `get_workspace_state` | Read all views, memory, and history |
| `list_diagram_views` | List views with permission levels |
| `get_diagram_view` | Read one view by key |
| `save_diagram_view` | Update a view (permission-checked) |
| `append_memory_note` | Append to a memory file (permission-checked) |
| `compose_claude_md` | Return static CLAUDE.md behavior instructions |
| `list_history` | List history snapshots |

All write operations check permissions before executing. If a user
doesn't have edit access, the MCP server returns a clear error.

### MCP Call Logger

Every tool call is logged to `mcp_call_logs` with timestamp, tool name,
input, duration, and success/error.

---

## 7. Context Loading

### Hook (reading)

A Claude Code hook (`hooks/load-workspace.sh`) runs at session start
and loads the full workspace context from Supabase. Claude has all
5 tabs of content before the first message.

### CLAUDE.md (writing behavior)

Static file — never changes. Three lines:

```
Write to Delma when the user confirms a fact:
- append_memory_note for people, logic, environment, or session updates
- save_diagram_view for architecture or diagram changes

Only write confirmed facts. Never write inferences. Batch updates.
```

The hook handles reading. CLAUDE.md handles writing rules.

---

## 8. Bidirectional Editing

Both Claude and the user write to the same Supabase tables.
Supabase Realtime pushes changes to all connected clients.
No polling. No manual refresh.

Conflict model: last-write-wins. History snapshots on every save
make any overwrite recoverable.

---

## 9. The Product Thesis

Delma is a **context layer that makes AI assistants usable by
non-technical people** on technical projects.

The PM doesn't need to be technical because Claude has the
Environment tab (every ID, every API endpoint) and the Campaign
Logic tab (every business rule). The PM just says what they want
in plain English. Claude does the rest.

The diagrams and memory aren't documentation — they're the
**shared truth** that makes this possible.
