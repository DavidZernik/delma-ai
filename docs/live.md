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
Claude Code  -->  Delma MCP Server  -->  Supabase (Postgres + Realtime)
                                              ^
                                              |
                                         Delma Web App
                                     (Supabase Realtime subscriptions)
                                              |
                                         DeepSeek API
                                     (NL editing, proactive questions,
                                      conversation sync patches)
```

Both Claude (via MCP) and the user (via web app) write to the same
Supabase tables. Supabase Realtime pushes changes to all connected
clients instantly.

---

## 3. Organization and Workspace Hierarchy

```
Organization (e.g. "Emory Healthcare")
  ├── Org-level tabs (shared across all projects)
  │   ├── SFMC Setup (environment.md)
  │   └── People (people.md)
  └── Workspaces (e.g. "Birthday Campaign")
      ├── Diagram views (Architecture, Org Chart, etc.)
      └── Memory notes (logic.md, session-log.md, etc.)
```

Users belong to organizations. Each org has shared tabs (people,
environment) and multiple workspaces for individual projects.

---

## 4. Tabs

Every tab is markdown. Some contain inline Mermaid diagrams. No
separate "diagram type" vs "document type" — just content.

### Org-level tabs (shared across all projects)

| Tab | What it answers | Default permission |
|-----|----------------|-------------------|
| SFMC Setup | Where do I find this ID/URL/key? | view-admins |
| People | Who owns what? Who decides? | edit-all |

### Project-level tabs

| Tab | What it answers | Default permission |
|-----|----------------|-------------------|
| Architecture | How does the system flow? | view-all |
| Campaign Logic | What are the business rules? | view-all |
| Environment | Project-specific IDs and config | view-admins |
| Session Log | What's done? What's left? | private (per user) |

---

## 5. Tab Permissions

Each tab has a permission level that controls who can see and edit it.
This is enforced at two levels: Postgres RLS policies (hard boundary)
and UI controls (lock icons, hidden Edit buttons).

| Permission | Who sees it | Who edits it |
|-----------|-------------|-------------|
| `private` | Only the owner | Only the owner |
| `view-all` | All workspace members | Only owners/admins |
| `edit-all` | All workspace members | All workspace members |
| `view-admins` | Only owners/admins | Only owners/admins |

---

## 6. Supabase Backend

### Tables

| Table | Purpose |
|-------|---------|
| `organizations` | Named orgs (e.g. "Emory Healthcare") |
| `org_members` | Who belongs to each org + role + active_workspace_id |
| `org_memory_notes` | Org-level shared tabs (people, environment) |
| `workspaces` | Named workspaces within an org |
| `workspace_members` | Who belongs + role (owner/member) |
| `diagram_views` | Mermaid diagrams with title, description, summary, permission |
| `memory_notes` | Markdown documents with filename, content, permission |
| `history_snapshots` | Timestamped JSON snapshots on every save |
| `mcp_call_logs` | Every MCP tool call logged for analytics |

### Auth

Supabase Auth with email/password. First login auto-creates the account.

### Real-time

`diagram_views`, `memory_notes`, and `org_memory_notes` have Supabase
Realtime enabled. When Claude writes via MCP, the web app updates live.

---

## 7. The MCP Server

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
| `sync_conversation_summary` | Sync facts from conversation into workspace (see below) |
| `compose_claude_md` | Return CLAUDE.md behavior instructions |
| `list_history` | List history snapshots |

All write operations check permissions before executing. If a user
doesn't have edit access, the MCP server returns a clear error.

### Conversation Sync

The `sync_conversation_summary` tool is the primary way context flows
from Claude Code conversations into Delma. Claude calls it every few
exchanges with a plain-English summary of what was discussed.

The tool:
1. Reads all current workspace tabs from Supabase
2. Sends the summary + current content to DeepSeek
3. DeepSeek returns JSON patches for tabs that need updating
4. Patches are applied to Supabase
5. Supabase Realtime pushes changes to the web app

This means the web app updates in real-time as the user talks to
Claude — no manual syncing, no polling.

### CLAUDE.md Instructions

CLAUDE.md tells Claude when to sync:
- After a decision is confirmed
- When a new person or system is mentioned
- After working out technical details
- When finishing a task or switching topics
- If 5+ exchanges have passed without a sync

### MCP Call Logger

Every tool call is logged to `mcp_call_logs` with timestamp, tool name,
input, duration, and success/error. Console logs (`[mcp]` prefix) trace
every tool call with timing on the server side.

---

## 8. Context Loading

Context flows into Claude Code through two mechanisms at different
stages of a conversation:

### Session start: full content (via hook)

A Claude Code hook (`hooks/load-workspace.sh`) runs once at session
start and loads the full workspace content from Supabase — all tabs
dumped to stdout. Claude has every detail before the first message.

### Ongoing: summary in CLAUDE.md (auto-updated)

After every MCP write, `refreshClaudeMd()` reads all tabs, sends
them to DeepSeek, and writes a condensed summary to CLAUDE.md locally.
Claude Code auto-loads CLAUDE.md, so it always has the latest workspace
context without dumping raw content each turn.

This matters because Claude Code compacts earlier messages as the
context window fills. The full tab content from the hook gets
compacted away, but CLAUDE.md survives — so Claude retains the
summary even in long conversations.

### Tradeoff

Summaries are token-efficient but lose detail. Full content is
accurate but burns context. The current approach balances this:
full detail at session start, summary for persistence.

---

## 9. Web App Features

### Natural Language Editing

Users can edit any tab using plain English. Type a description of the
change, press Apply, and DeepSeek rewrites the content using a JSON
patch format (fast — only outputs the diff, not the full document).

Flow: Apply → loading dots (three pulsing red dots in the action slot)
→ DeepSeek returns JSON patches ({find, replace} format for speed)
→ editor highlights changed lines with red tint (1.5s pause)
→ auto-saves to Supabase → switches to view mode
→ content fades in with red border flash.

Enter/Return key triggers Apply. Both proactive question answers
and manual NL edits follow the same flow.

### Proactive Questions

DeepSeek analyzes tab content and surfaces questions about gaps
(missing people, unclear logic, incomplete diagrams). Questions appear
in a fixed action slot below the tab header.

Timing: first check 30s after load, then every 5 minutes.
User must be idle 3s before a question fires.
Dismissed questions don't reappear for that tab.

### Mermaid Diagrams

Diagrams render with custom branding (cream/red palette), zoom
controls, pinch-to-zoom, drag-to-pan. Inline Mermaid in markdown
tabs is auto-rendered.

### Real-time Sync

When another client (Claude via MCP or another browser tab) writes
to Supabase, the active tab fades and re-renders with the new content,
plus a red border flash animation to signal the update. Inactive tabs
show a dot indicator on their pill.

If the user is in edit mode when an external change arrives, a status
message appears instead of overwriting the editor: "Content updated
externally — save or cancel to see changes."

---

## 10. Bidirectional Editing

Both Claude and the user write to the same Supabase tables.
Supabase Realtime pushes changes to all connected clients.
No polling. No manual refresh.

Conflict model: last-write-wins. History snapshots on every save
make any overwrite recoverable.

---

## 11. The Product Thesis

Delma is a **context layer that makes AI assistants usable by
non-technical people** on technical projects.

The PM doesn't need to be technical because Claude has the
Environment tab (every ID, every API endpoint) and the Campaign
Logic tab (every business rule). The PM just says what they want
in plain English. Claude does the rest.

The diagrams and memory aren't documentation — they're the
**shared truth** that makes this possible.

---

## 12. Observability

Console logs with prefixes trace every operation:

| Prefix | Layer | What it covers |
|--------|-------|----------------|
| `[delma init]` | Frontend | App startup, auth, workspace load |
| `[delma auth]` | Frontend | Login, signup, session check |
| `[delma workspace]` | Frontend | Open, refresh (timing + counts) |
| `[delma realtime]` | Frontend | Subscription setup, change handling |
| `[delma save]` | Frontend | Tab saves to Supabase |
| `[delma apply]` | Frontend | Apply flow (both NL edit + proactive) |
| `[delma render]` | Frontend | Diagram/markdown render with content info |
| `[delma refresh]` | Frontend | Supabase fetch timing + error checking |
| `[delma prompt]` | Frontend | Proactive engine ticks, questions, dismissals |
| `[delma gap]` | Frontend | DeepSeek gap analysis (timing + responses) |
| `[delma patch]` | Frontend | Patch-based editing (timing + patch details) |
| `[mcp]` | Server | All MCP tool calls with timing |
| `[mcp sync]` | Server | Conversation sync patches |
| `[delma-state]` | Server | Supabase CRUD operations + errors |
