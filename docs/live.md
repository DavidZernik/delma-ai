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
                              ┌───────────────┴───────────────┐
                              |                               |
                         DeepSeek API                  Claude Haiku 4.5
                    (markdown patches,              (Mermaid diagram
                     proactive gaps,                 structural edits,
                     sync conversation)              via /api/chat proxy)
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

### Org-level tabs (shared across all projects in the org)

| Tab | Filename | What it answers | Default permission |
|-----|----------|----------------|-------------------|
| People | people.md | Who owns what? Who decides? | edit-all |
| General Patterns and Docs | playbook.md | How work happens across projects | edit-all |

### Project-level tabs (in tab-bar order, left to right)

| Tab | Storage | Type | What it answers | Default permission |
|-----|---------|------|----------------|-------------------|
| Project High Level | `diagram_views` (architecture) | markdown + Mermaid | How the system flows | view-all |
| Project Details | `memory_notes` (decisions.md) | memory | Decisions + actions, outline form | edit-all |
| Files Locations and Keys | `memory_notes` (environment.md) | memory | IDs, DEs, journeys, automations | view-admins |

### User-level tab (private, follows you across orgs)

| Tab | Storage | Type | What it answers | Permission |
|-----|---------|------|----------------|-----------|
| My Notes | `user_notes` table | per-user | Personal scratchpad | only you, always |

**My Notes is GLOBAL** — keyed by `user_id`, NOT by workspace or org.
The same notes follow you whether you're in Birthday Campaign, Memorial
Day Campaign, or any project in any org. Like a notebook you carry.

### What changes when you switch context

| Action | What changes |
|--------|--------------|
| Switch project (same org) | Project High Level, Project Details, Files Locations swap. People + Playbook stay. My Notes stays. |
| Switch org | Everything project-level swaps. People + Playbook for the new org load. My Notes stays. |
| Sign out | All workspace context cleared. My Notes preserved server-side. |

### How writes happen (structured ops, not content rewrites)

Every memory tab is stored as **structured JSON** in a `structured`
column, and the rendered markdown `content` is regenerated from it.
The LLM (in the web router or in Claude Desktop via MCP) never
rewrites entire tab content — it picks one of a small set of typed
operations and fills 2–3 fields. Deterministic code does the actual
mutation + render. This is the most important architectural invariant
in Delma; see Section 13 for the full design.

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
| `org_memory_notes` | Org-level shared tabs (people, playbook) |
| `workspaces` | Named projects within an org |
| `workspace_members` | Who belongs + role (owner/member) |
| `diagram_views` | Mermaid diagrams with title, description, summary, permission |
| `memory_notes` | Markdown documents with filename, content, permission |
| `user_notes` | Per-user GLOBAL notes (My Notes) — keyed by user_id, follows across orgs/projects |
| `history_snapshots` | Timestamped JSON snapshots on every save |
| `mcp_call_logs` | Every MCP tool call logged for analytics |
| `__delma_migrations` | Migration tracking — one row per applied SQL file |

### Auth

Supabase Auth with email/password. First login auto-creates the account.

### Real-time

`diagram_views`, `memory_notes`, `org_memory_notes`, and `user_notes`
have Supabase Realtime enabled. When Claude writes via MCP, the web
app updates live.

### Migrations (DDL)

The Supabase JS client can't run DDL (CREATE TABLE etc.). For schema
changes, we use a one-off Node script (`server/run-migrations.js`) that
connects via `DATABASE_URL` (set in `.env`, gitignored) using the `pg`
driver. It tracks applied migrations in `__delma_migrations` so re-runs
are safe.

Run it: `node server/run-migrations.js`. The DATABASE_URL is the
Supabase pooler connection string from
**Connect → Direct → Connection pooling** in the dashboard.

---

## 7. The MCP Server

Runs locally via `npm run start:mcp` (stdio transport).
Requires env vars: `DELMA_WORKSPACE_ID`, `DELMA_USER_ID`.

| Tool | Purpose |
|------|---------|
**Read tools**
| Tool | Purpose |
|------|---------|
| `open_workspace` | Set active workspace by name or ID |
| `get_workspace_state` | Read all views, memory, and history |
| `list_diagram_views` / `get_diagram_view` | Read diagrams |
| `compose_claude_md` | Return CLAUDE.md behavior instructions |
| `list_history` | List history snapshots |

**Typed-op tools (structured tabs)** — one tool per operation. Claude
Desktop picks the right tool from the conversation; deterministic code
mutates the structured JSON + re-renders the view. No full rewrites.

| Tool | Tab | Args |
|------|-----|------|
| `delma_add_person` | People | name, role?, kind?, reports_to? |
| `delma_set_role` | People | person, role |
| `delma_remove_person` | People | name |
| `delma_add_reporting_line` | People | from, to |
| `delma_add_playbook_rule` | Playbook | text, section? |
| `delma_set_environment_key` | Environment | key, value, note? |
| `delma_add_decision` | Decisions | text, owner? |
| `delma_add_action` | Decisions | text, owner?, due? |
| `delma_complete_action` | Decisions | id |
| `delma_append_my_note` | My Notes | text |

**Legacy tools (still present for diagram_views + bulk sync)**
| Tool | Purpose |
|------|---------|
| `save_diagram_view` | Update a Mermaid diagram view (architecture, etc.) |
| `append_memory_note` | Free-form append to a memory file (legacy) |
| `sync_conversation_summary` | Bulk-sync facts from conversation (legacy) |

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

## 8. Context Loading & Bidirectional Sync

Context flows into Claude Code through three mechanisms working together
to maintain true bidirectional sync between the web app and the chat.

### Active project follows the web app

Both the SessionStart hook and the MCP server look up the user's
**`org_members.active_workspace_id`** at startup — that's whatever
project tab is currently open in the browser. No hardcoded workspace
in `.mcp.json`. Switch projects in the browser → next Claude Code
session sees the new project.

For mid-session switches: when the web app's project dropdown changes,
it both updates `active_workspace_id` AND triggers `/api/refresh-claude-md`,
so the next message you send Claude sees the new project's content.

### Privacy default: writes off until "delma on"

CLAUDE.md leads with a privacy contract:

- **Reads always on.** Claude can see the workspace from the moment
  the session starts.
- **Writes OFF by default.** Claude will NOT call `sync_conversation_summary`,
  `save_diagram_view`, or `append_memory_note` unless the user explicitly
  enables it.

Triggers:
- "delma on" / "record this" / "sync to delma" → creates `.claude/.delma-on`
  flag, Claude starts syncing
- "delma off" / "stop recording" → removes the flag, Claude goes silent

Claude must check the flag before any write tool call.

### Session start: full content (via hook)

`hooks/load-workspace.sh` runs once at session start and loads the full
workspace content from Supabase — all tabs dumped to stdout. Claude has
every detail before the first message.

### Ongoing: summary in CLAUDE.md (auto-updated)

After every MCP write OR web app save, `refreshClaudeMd()` (server-side)
reads all tabs, sends them to the summarizer (DeepSeek → Haiku fallback),
and writes a condensed summary to CLAUDE.md locally. Two trigger points:

1. **MCP writes** — `server/mcp.js` calls `refreshClaudeMd()` after
   every `save_diagram_view`, `append_memory_note`, or
   `sync_conversation_summary`.
2. **Web app saves** — frontend calls `POST /api/refresh-claude-md`
   after every Save and after every router write. Server runs the same
   summarizer and updates the file.

### Per-message: smart hook injects fresh content (only when changed)

`hooks/inject-claude-md.sh` is a `UserPromptSubmit` hook registered in
`.claude/settings.json`. Before every user message:

1. Reads CLAUDE.md mtime
2. Compares to the last-injected mtime (stored in `.claude/.delma-last-injected-mtime`)
3. **If unchanged**: exits silently (zero token cost — most messages)
4. **If changed**: injects fresh CLAUDE.md content wrapped in
   `<delma-fresh-context>` with a one-line "X seconds ago" timestamp,
   plus a fallback instruction telling Claude to call `get_workspace_state`
   if it suspects further drift

### Net result: true bidirectional sync

- **Claude → Web app**: MCP write → Supabase → Realtime websocket pushes
  to all open browsers (instant)
- **Web app → Claude**: Save → server refreshes CLAUDE.md → next user
  message → hook injects fresh content (~1-10s end-to-end)
- **Mid-session drift**: Claude can call `get_workspace_state` for fresh
  data on demand

### Cost model

- Most messages: zero token overhead (file unchanged → hook injects nothing)
- After any web edit: one fresh CLAUDE.md injection (~500 tokens)
- ~$0.0015 per fresh injection at Sonnet pricing — negligible

---

## 9. Web App Features

### Natural Language Editing — Typed-Op Router

All user input (proactive question answers + manual NL edits) flows
through a **typed-op router** that uses Claude Haiku 4.5 via the
`/api/chat` proxy.

**How it works:**
1. The router sees all tabs with their **current structured JSON state**
   (not rendered markdown — the actual data shape).
2. It returns a list of TYPED OPERATIONS as JSON:
   `[{ "tab": "org:people.md", "op": "add_person", "args": {...} }, ...]`
3. The web app POSTs each tab's ops to `/api/op`, which calls
   `applyOpsToTab()` → mutates structured JSON → re-renders content →
   writes both back to Supabase.
4. Realtime pushes changes to all connected clients.

**Why typed ops:**
- LLM emits ~10 tokens (op name + args), not hundreds (rewritten content)
- Zero syntax errors possible — code does the rendering
- Every op is auditable, named, testable
- New features = new handler + eval case, not more prompt rules

**Rules in the (much smaller) system prompt:**
- Respect each tab's scope.
- "Corrections" use update-style ops (`set_role`) not add-style.
- Ambiguous / irrelevant input → `[]` (no guessing, no prose).

**Cost**: ~$0.001–0.003 per input (median ~800ms round-trip).

**Test harness**: `scripts/eval-router.js` runs 9 scored cases against
the live prompt. `npm run eval:router`. All passing.

### Proactive Questions

DeepSeek analyzes tab content and surfaces questions about gaps
(missing people, unclear logic, incomplete diagrams). Questions appear
in a fixed action slot below the tab header.

Timing: first check 30s after load, then every 5 minutes.
User must be idle 3s before a question fires.
Dismissed questions don't reappear for that tab.

### Mermaid Diagrams — typed visual vocabulary per tab

Each tab type has its own shape + color + emoji vocabulary baked into
the router system prompt, so future updates produce diagrams in the
right style automatically.

**Project High Level (SFMC architecture):**
- Cylinders for Data Extensions, hexagons for Automations, stadiums for
  Journeys, parallelograms for Emails, trapezoids for CloudPages,
  diamonds for Decisions
- Light color tints per category (DE blue, email beige, journey pink, etc.)
- Emoji prefixes: 💾 ⚙️ 🔍 ⚡ 📧 🌐 🔀
- Layer subgraphs group nodes by role ("Patient Source", "Daily Filter")
- Floating italic labels next to each technical node

**People (org charts):**
- Stored as `{people: [{id, name, role, kind, reports_to}]}` and
  rendered to Mermaid by `src/tab-ops.js`
- Shapes per role: rounded for ICs/managers, trapezoid for stakeholders,
  cylinder for teams, parallelogram for vendors

**General Patterns and Docs (process flows):**
- 📝 process steps, 🚦 approval diamonds, ⏳ wait hexagons, ✅ actions,
  📄 docs, 🚫 hard-rule diamonds with brand-red border

### Zoom

Every tab gets +/- zoom controls in the top-right of the card.
Architecture's setZoom scales the SVG via transform + prose via CSS zoom.
Markdown tabs use CSS `zoom` on the entire `.markdown-content` so text,
tables, headings, and inline Mermaid SVGs all scale uniformly.

### Loading

`renderWorkspace()` hides `diagramOutput` (visibility:hidden + opacity 0)
before any tab switch or refresh. Reveal happens only after the new
content is fully prepared (Mermaid rendered, branding applied, layout
settled via two rAFs). No flash of unstyled content. Init waits until
real workspace data loads before revealing — no template flicker.

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
| `[delma router]` | Frontend | Typed-op router — tabs seen, ops parsed, /api/op posts |
| `[delma edit]` | Frontend | Manual NL edit entry point |
| `[delma onApply]` | Frontend | Proactive question answer entry point |
| `[delma reveal]` | Frontend | Hide / reveal cycle for tab content |
| `[delma inline-zoom]` | Frontend | Zoom on markdown tabs (text + diagrams together) |
| `[delma fit]` | Frontend | SVG natural width vs wrapper width measurements |
| `[delma claude-md]` | Frontend | CLAUDE.md refresh trigger after web saves |
| `[server]` | Server | /api/refresh-claude-md endpoint timing |
| `[mcp]` | Server | All MCP tool calls with timing |
| `[mcp sync]` | Server | Conversation sync patches |
| `[delma-state]` | Server | Supabase CRUD operations + errors |
| `[server] op:` | Server | `/api/op` endpoint — typed-op application |

---

## 13. Structured Tabs (the architecture that beats prompt engineering)

**Principle**: the LLM never rewrites tab content. It picks one of a
small set of typed operations and fills 2–3 fields. Deterministic
code does the actual mutation and rendering. This is what keeps
Delma reliable as features grow.

### The three layers

| Layer | What it does | Cost when wrong |
|---|---|---|
| **Schema** (JSON in `structured` column) | Source of truth | Fix in code; data round-trips |
| **Renderer / op handlers** (`src/tab-ops.js`) | Pure functions: data ↔ markdown | Fix in code; testable |
| **LLM** (Haiku via `/api/chat` or Claude Desktop via MCP) | Classify intent, fill 2–3 fields | Bounded — can only call known ops |

### File map

| File | Role |
|---|---|
| `src/tab-ops.js` | Schemas, renderers, op handlers (pure). Shared browser+node. |
| `src/router-prompt.js` | Compact system prompt that returns typed ops. |
| `src/extract-json-array.js` | Robust JSON-array parser (ignores trailing prose). |
| `server/lib/apply-op.js` | Reads row → applies ops → writes structured + content. |
| `server/index.js` → `POST /api/op` | Web app endpoint for typed ops. |
| `server/mcp.js` | `delma_*` MCP tools — one per op. |
| `scripts/eval-router.js` | 9 scored eval cases. `npm run eval:router`. |
| `scripts/backfill-structured.js` | One-shot legacy markdown → structured JSON. |
| `supabase/migrations/007_structured_tabs.sql` | Adds `structured jsonb` columns + GIN indexes. |

### Tab schemas

```
people.md     → { people: [{id, name, role, kind, reports_to: [id]}] }
playbook.md   → { rules: [{id, text, section?}] }
environment.md → { entries: [{key, value, note?}] }
decisions.md  → { decisions: [{id, text, owner?}], actions: [{id, text, owner?, due?, done}] }
my-notes.md   → { text: string }
```

`structured` is the source of truth. `content` (markdown) is regenerated
from it on every write so what users see is always in sync.

### Available ops

Defined in `src/tab-ops.js` and exposed both via `/api/op` (web) and
`delma_*` MCP tools (Claude Desktop). See Section 7 for the full
MCP surface.

### Two write paths, same handlers

- **Web NL router**: input → Haiku returns `[{tab, op, args}]` →
  `POST /api/op` → `applyOpsToTab`
- **Claude Desktop**: in conversation → picks a `delma_*` MCP tool →
  server-side `runOp` → same `applyOpsToTab`

Both end at the exact same pure functions in `src/tab-ops.js`.

### Backfill

Existing rows with `content` but no `structured` were converted in a
one-shot run of `scripts/backfill-structured.js`:
- Deterministic regex parsers for Decisions, Environment, Playbook,
  My Notes (simple bullet/heading structures)
- Haiku-assisted parser for People (Mermaid → JSON)
- Re-run is idempotent (skips rows already in structured mode)

### Why this matters

| Before (prompt-driven full rewrites) | After (typed ops) |
|---|---|
| LLM emits hundreds of tokens of markdown/Mermaid | LLM emits ~10 tokens of JSON |
| Syntax errors possible on every edit | Zero — renderer is deterministic |
| 2–5s per edit | ~800ms median |
| Router prompt grew with every feature | Prompt shrunk; new feature = handler + eval case |
| No record of "what changed" | Every op auditable, named, testable |
| Photo loss, mangled diagrams, lost rules | Deterministic — can't lose what code didn't touch |

---

## 14. Quality Lab — overnight self-evaluation

While David sleeps (10pm–7am PT), the server runs one comprehensive
end-to-end test plus cheap regression + hygiene checks. Findings persist
to `quality_*` tables and are visible publicly at **`/logs`**.

### Headline overnight job — replay-first, narrative-fallback

The runner picks one of two modes based on real activity:

**REPLAY mode** (when there are ≥5 real `api_op_logs` from the last 24h):
1. Pulls yesterday's actual router inputs + ops that ran in production
2. For each op, reconstructs the structured state before it ran
3. Re-applies the op against a fresh in-memory copy
4. Sends the user input + before/after state to a **Sonnet critic** that
   grades 1–5: did this op match what the user actually said?
5. Writes per-op observations to `quality_observations` (severity:
   clean / minor / suspicious / wrong)

**NARRATIVE mode** (when production traffic is sparse — early days):
- Runs a small library of curated multi-turn conversation scripts (in
  `server/quality/narratives.js`). Each script is a deliberate full-arc
  workday — a PM onboarding, a scope pivot mid-conversation, chitchat
  mixed with real facts — written by hand with an "expected outcome"
  ground truth.
- For each script: a Haiku "Claude" decides which typed ops to call
  per turn, ops apply via the same `/api/op` code path, then a Sonnet
  critic compares the final structured state against the expected
  outcome. Stored in `quality_simulations`.

The two modes share the same critic schema, so the morning view treats
them identically.

### Two distinct timeliness modes (per David's framing)

`server/quality/timeliness.js` separates:

| Mode | What it measures | Source |
|------|------------------|--------|
| **A — "Claude was slow to call the tool"** | Claude saw relevant info but processed N more messages before calling MCP | For narrative/replay: precise (we have both timestamps). For real Claude Code: approximated via 5–60min gaps between consecutive MCP calls. (True measurement requires conversation-side timestamps from Claude Desktop — possible by extending `hooks/inject-claude-md.sh` to log a per-message tick.) |
| **B — "Delma applied the op slowly"** | Server-side latency from receiving op to applying it | `api_op_logs.duration_ms`, `mcp_call_logs.duration_ms`. Pure Delma. |

Both bucket into `quality_signals` rows and surface on `/logs` with
percentile distributions.

### The supporting layers (always run nightly)

| Layer | What it does | Output table |
|-------|--------------|--------------|
| Regression evals | Runs the canonical eval suite (`server/quality/eval-cases.js`) — shared with `scripts/eval-router.js` | `quality_eval_runs` |
| State hygiene | Pure SQL: orphan arch nodes, overdue actions, unowned old decisions, roleless people | `quality_state_checks` |
| Router signal mining | Clusters last 24h router calls: empty-ops, fan-outs → Sonnet asks "what's missing?" | `quality_signals` |
| A/B leaderboard *(opt-in)* | Re-runs eval suite against alternate model+prompt combos | `quality_experiments` |

### Manual triggers

```
POST /quality/run             # cheap layers only
POST /quality/run-overnight   # full overnight pipeline (replay or narrative + cheap layers)
```

Both return immediately; jobs run in the background.

### What you see at /logs

Top of the page is **Things to act on** — a sorted, deduplicated table
that pulls the highest-severity findings from every layer (failed evals,
suspicious/wrong critique observations, state warnings, sim missed/wrong
items) into one row-per-issue actionable view. Below that:

- Summary stats + per-layer status (when each last ran, any errors)
- Overnight simulation (latest 7) with score + summary + drill-down
- Regression evals (latest run, full per-case table)
- State hygiene findings
- Signal patterns (timeliness mode-A and mode-B + router clusters)
- A/B experiments
- Recent `/api/op` writes (raw)
- Recent router calls (raw)

### Files

| File | Role |
|---|---|
| `server/quality/runner.js` | Master entry: dispatches replay vs narrative + runs cheap layers |
| `server/quality/replay.js` | Replays real production ops with critic |
| `server/quality/narratives.js` | Curated full-arc conversation scripts + runner |
| `server/quality/timeliness.js` | Two-mode latency analysis (no LLM) |
| `server/quality/eval-cases.js` | Canonical eval cases (shared with `scripts/eval-router.js`) |
| `server/quality/logs-page.js` | `/logs` HTML renderer (server-side, no JS) |
| `supabase/migrations/009_quality_lab.sql` | quality_* tables + api_op_logs |
| `supabase/migrations/010_quality_simulations.sql` | quality_simulations table |
