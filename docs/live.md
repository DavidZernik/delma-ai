# Delma Live — the product that exists now

This is the canonical reference for the product as it exists in the
repo today.

Read this if you want to understand:
- what Delma is right now
- what the web app shows and does
- how the MCP server works and what tools it exposes
- how Supabase stores everything (no local files)
- how bidirectional editing and real-time sync work
- how shared vs private visibility works

For future features and product direction, see `docs/future.md`.

---

## 1. What Delma is right now

> **Delma is a persistent visual workspace for Claude Code: a web app
> that keeps your system map, diagrams, and project memory visible
> while Claude works — backed by Supabase, with live real-time sync.**

The live product has three jobs:

- keep the shared workspace map visible beside Claude Code at all times
- give Claude Code a structured memory it can read from and write to via MCP
- update the visual layer in real time when anyone makes changes

No local files. No repos required. Everything lives in Supabase.

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

## 3. What the Web App Shows

Three tabs, always visible:

1. **Architecture** — Mermaid diagram of systems, integrations, data flow.
   Shared across all workspace members.

2. **Org Chart** — Mermaid diagram of people, ownership, trust boundaries.
   Shared across all workspace members.

3. **High Level Project Details** — Generated prose from all diagrams
   and memory notes. Read-only synthesis.

Each diagram tab has View and Edit modes. Edit mode shows raw Mermaid
source. Mermaid syntax errors are caught before saving.

---

## 4. Supabase Backend

All state lives in Supabase Postgres. No local `.delma/` folder.

### Tables

| Table | Purpose |
|-------|---------|
| `workspaces` | Named workspaces (e.g. "birthday", "kpi-dashboard") |
| `workspace_members` | Who belongs to which workspace + role (owner/member) |
| `diagram_views` | Mermaid diagrams with title, description, summary, visibility |
| `memory_notes` | Structured markdown files (environment.md, logic.md, people.md, session-log.md) |
| `history_snapshots` | Timestamped JSON snapshots on every save |
| `mcp_call_logs` | Every MCP tool call logged for the analyzer app |

### Auth

Supabase Auth with email/password. First login auto-creates the account.

### Row Level Security

Users can only see workspaces they're members of. Private items
(session-log.md) only visible to their owner. All enforced at the
database level.

### Real-time

`diagram_views` and `memory_notes` tables have Supabase Realtime enabled.
When Claude writes via MCP or a user edits in the web app, all connected
clients get the update instantly via WebSocket subscription.

---

## 5. Visibility Rules (Fixed)

| Item | Visibility |
|------|-----------|
| Architecture diagram | Shared — all workspace members see it |
| Org Chart diagram | Shared |
| environment.md | Shared |
| logic.md | Shared |
| people.md | Shared |
| session-log.md | Private — only the owner sees their own |
| High Level Project Details | Generated from shared content |

---

## 6. The MCP Server Tools

The MCP server runs locally via `npm run start:mcp` (stdio transport).
Claude Code connects to it via `.mcp.json`.

Requires env vars: `DELMA_WORKSPACE_ID`, `DELMA_USER_ID`.

| Tool | Purpose |
|------|---------|
| `open_workspace` | Set active workspace by name or ID. Creates if not found. |
| `get_workspace_state` | Read full workspace: views, memory, history. |
| `list_diagram_views` | List available Mermaid views. |
| `get_diagram_view` | Read one view by key. |
| `save_diagram_view` | Update a view + write history snapshot. |
| `append_memory_note` | Append to a memory file. |
| `compose_claude_md` | Generate CLAUDE.md content from workspace state. |
| `list_history` | List history snapshots. |

### MCP Call Logger

Every tool call is logged to the `mcp_call_logs` table with timestamp,
tool name, input payload, duration, and success/error. This is the raw
data source for the analyzer app.

---

## 7. Claude Auto-Update Behavior

The generated CLAUDE.md includes instructions telling Claude to call
MCP tools automatically during conversations:

- Call `get_workspace_state` at the start of each conversation
- Call `append_memory_note` when the user confirms a fact
- Call `save_diagram_view` when a structural relationship changes
- Only write confirmed facts, never inferences
- Batch updates into single calls

---

## 8. Bidirectional Editing

Both Claude and the user write to the same Supabase tables.

- User edits Mermaid in the web UI -> saves -> Supabase row updates ->
  Realtime pushes to all clients
- Claude calls `save_diagram_view` via MCP -> Supabase row updates ->
  Realtime pushes to all clients (including the web app)

No polling. No manual refresh. Both write sources converge on the same
database as the single source of truth.

Conflict model (V1): last-write-wins. History snapshots on every save
make any overwrite recoverable.

---

## 9. OpenMemory Integration

OpenMemory MCP runs as a separate, side-by-side MCP server. Claude Code
has both MCP servers configured:

- **OpenMemory** — fuzzy memory retrieval ("what did we decide about X?")
- **Delma** — visual workspace ("update the org chart, log this fact")

No integration code between them. Complementary, not competing.

---

## 10. The Live Product Thesis

> **Delma is the persistent project memory Claude Code reads from and
> writes to — made visible as a live map you keep open beside your work,
> that both you and Claude can edit, backed by Supabase so it works
> from anywhere without a local repo.**
