# Delma Live — the product that exists now

This is the canonical reference for the product as it exists in the
repo today.

---

## 1. What Delma is

> **Delma is a visual workspace with an embedded AI chat that captures
> project context and makes it visible, editable, and shareable — so
> non-technical people can manage technical projects without needing an
> engineer.**

Everything lives in Supabase. The web app is the primary surface:
workspace on the left, Claude chat sidebar on the right. Claude runs
via the Agent SDK server-side, with Delma's typed ops exposed as MCP
tools internally. A standalone MCP server also exists for Claude Code
(local CLI) users.

---

## 2. Architecture

```
Browser
  ├── Workspace UI (vanilla JS, left pane)
  │     ├── Typed-op router (Haiku) for NL edits
  │     ├── Supabase Realtime subscriptions
  │     └── Mermaid diagram renderer
  └── Chat sidebar (React island, right pane)
        └── SSE stream ←→ POST /api/chat/stream

Express Server (Render)
  ├── /api/chat/stream ── Claude Agent SDK ── Anthropic API
  │                           ├── Default tools (Bash, Read, Write, etc.)
  │                           └── Delma MCP server (internal, typed ops)
  ├── /api/op ── applyOpsToTab (web router writes)
  ├── /api/chat ── proxy for Haiku/DeepSeek calls (router, proactive Qs)
  ├── /logs ── quality lab dashboard (server-rendered HTML)
  └── /quality/* ── overnight + smoke run triggers

Supabase (Postgres + Auth + Realtime)
  └── Source of truth for all workspace data

External services:
  - Helicone: LLM observability (all Anthropic calls proxied)
  - Gemini: embeddings for semantic dedup (free tier)
  - DeepSeek: proactive gap analysis + conversation sync
```

Both Claude (via chat or MCP) and the user (via web app) write to the
same Supabase tables. Supabase Realtime pushes changes to all connected
clients instantly.

---

## 3. Organization and Workspace Hierarchy

```
Organization (one per user — no multi-org for now)
  ├── Org-level tabs (shared across all projects)
  │   ├── People (people.md)
  │   └── General Patterns and Docs (playbook.md)
  └── Workspaces (e.g. "Birthday Campaign")
      ├── Diagram views (Architecture, etc.)
      └── Memory notes (decisions.md, environment.md, etc.)
```

One org auto-created per user. Flat tab presentation: org-level and
project-level tabs render together in the tab bar. One long-running
conversation per workspace (no multi-thread).

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
Day Campaign, or any project in any org.

### What changes when you switch context

| Action | What changes |
|--------|--------------|
| Switch project (same org) | Project High Level, Project Details, Files Locations swap. People + Playbook stay. My Notes stays. |
| Switch org | Everything project-level swaps. People + Playbook for the new org load. My Notes stays. |
| Sign out | All workspace context cleared. My Notes preserved server-side. |

### How writes happen (structured ops, not content rewrites)

Every memory tab is stored as **structured JSON** in a `structured`
column, and the rendered markdown `content` is regenerated from it.
The LLM never rewrites entire tab content — it picks one of a small set
of typed operations and fills 2-3 fields. Deterministic code does the
actual mutation + render. This is the most important architectural
invariant in Delma; see Section 13 for the full design.

---

## 5. Tab Permissions

Each tab has a permission level that controls who can see and edit it.
Enforced at two levels: Postgres RLS policies (hard boundary) and UI
controls (lock icons, hidden Edit buttons).

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
| `organizations` | Named orgs (one per user) |
| `org_members` | Who belongs to each org + role + active_workspace_id |
| `org_memory_notes` | Org-level shared tabs (people, playbook) |
| `workspaces` | Named projects within an org |
| `workspace_members` | Who belongs + role (owner/member) |
| `diagram_views` | Mermaid diagrams with title, description, summary, permission |
| `memory_notes` | Markdown documents with filename, content, permission |
| `user_notes` | Per-user GLOBAL notes (My Notes) — keyed by user_id |
| `history_snapshots` | Timestamped JSON snapshots on every save |
| `mcp_call_logs` | Every MCP tool call logged for analytics |
| `conversation_ticks` | One row per user message in Claude Code (via hooks) |
| `conversations` | Chat conversations (one per workspace) |
| `messages` | Ordered messages within conversations (user, assistant, tool, system) |
| `token_usage` | Per-user per-workspace monthly token accounting |
| `sfmc_accounts` | SFMC OAuth credentials per org (pgcrypto-encrypted) |
| `sfmc_audit_log` | Every SFMC operation the chat invokes |
| `quality_observations` | Critic findings from overnight runs |
| `quality_simulations` | Narrative simulation results |
| `quality_eval_runs` | Regression eval results per case |
| `quality_state_checks` | State hygiene findings |
| `quality_signals` | Timeliness + router signal patterns |
| `quality_experiments` | A/B leaderboard results |
| `quality_candidate_evals` | Auto-filed eval-case candidates from critic findings |
| `quality_runs` | Per-run grouping (run cards on /logs) |
| `quality_runner_status` | Layer-level status tracking |
| `api_op_logs` | Every /api/op write logged |
| `__delma_migrations` | Migration tracking — one row per applied SQL file |

### Auth

Supabase Auth with email/password. First login auto-creates the account.

### Real-time

`diagram_views`, `memory_notes`, `org_memory_notes`, and `user_notes`
have Supabase Realtime enabled. When Claude writes via typed ops, the
web app updates live.

### Migrations (DDL)

Schema changes use `server/run-migrations.js` — connects via
`DATABASE_URL` (`.env`, gitignored) using the `pg` driver. Tracks
applied migrations in `__delma_migrations` so re-runs are safe.

Run: `node server/run-migrations.js`. 17 migrations exist (001 through
017), covering initial schema through chat tables and SFMC credentials.

---

## 7. The Chat (Agent SDK)

Chat lives inside the Delma web app as a right-sidebar React island.
Claude runs server-side via the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).

### How it works

1. User types a message in `ChatSidebar.jsx`
2. `useChatStream.js` POSTs to `/api/chat/stream`
3. `server/chat/stream.js` calls `query()` from the Agent SDK with:
   - Default tools (Bash, Read, Write, Edit, Glob, Grep)
   - Delma's MCP server as an internal tool source (typed ops)
   - Per-workspace scratch directory for file operations
4. Server streams responses back via SSE
5. All messages persisted to `conversations` + `messages` tables

### Key design decisions

- **One conversation per workspace** — no multi-thread complexity
- **Always-on writes** — in-app chat writes freely (no "delma on/off"
  toggle; that privacy contract only applies to the external MCP path)
- **Model-agnostic** — defaults to `claude-sonnet-4-5`, configurable
  via `DELMA_CHAT_MODEL` env var
- **Scratch dirs** — each workspace gets `/tmp/delma-workspaces/<id>/`
  where Claude can write/read files

### Files

| File | Role |
|------|------|
| `server/chat/stream.js` | Agent SDK chat endpoint (SSE streaming) |
| `src/chat/ChatSidebar.jsx` | React component for the chat UI |
| `src/chat/useChatStream.js` | React hook for SSE streaming |
| `src/chat/mount.js` | React island mount/unmount for vanilla JS host |

---

## 8. The MCP Server (external + internal)

The MCP server serves two roles:

1. **Internal** — the Agent SDK chat calls it for typed ops
2. **External** — Claude Code connects via `npm run start:mcp` (stdio)

Requires env vars: `DELMA_WORKSPACE_ID`, `DELMA_USER_ID` (for external).

### Read tools

| Tool | Purpose |
|------|---------|
| `open_workspace` | Set active workspace by name or ID |
| `get_workspace_state` | Read all views, memory, and history |
| `list_diagram_views` / `get_diagram_view` | Read diagrams |
| `compose_claude_md` | Return CLAUDE.md behavior instructions |
| `list_history` | List history snapshots |

### Typed-op tools (one tool per operation)

**People:**
`delma_add_person`, `delma_set_role`, `delma_remove_person`,
`delma_add_reporting_line`, `delma_remove_reporting_line`, `delma_set_manager`

**Playbook:**
`delma_add_playbook_rule`, `delma_remove_playbook_rule`, `delma_supersede_rule`

**Environment:**
`delma_set_environment_key`, `delma_remove_environment_key`

**Decisions:**
`delma_add_decision`, `delma_add_action`, `delma_complete_action`,
`delma_complete_action_by_text`, `delma_supersede_decision`

**Architecture:**
`delma_arch_set_prose`, `delma_arch_add_node`, `delma_arch_set_node_label`,
`delma_arch_set_node_note`, `delma_arch_set_node_kind`, `delma_arch_move_node`,
`delma_arch_remove_node`, `delma_arch_add_edge`, `delma_arch_remove_edge`,
`delma_arch_add_layer`, `delma_arch_remove_layer`

**My Notes:**
`delma_append_my_note`

**Legacy (still present for diagram_views + bulk sync):**
`save_diagram_view`, `append_memory_note`, `sync_conversation_summary`

### Handler-level dedup

Ops that create items (`add_playbook_rule`, `add_decision`, `add_node`,
`add_action`, `add_edge`) enforce dedup at the handler level. The LLM
was told "don't duplicate" in prose and ignored it — now code enforces
it via:

- Stemmer + Jaccard + character-subsequence matching (sync, browser-safe)
- Gemini embeddings for semantic near-dups (server-side, `server/lib/similarity.js`)
- `add_edge` also runs cycle detection before inserting
- `add_node` dedup is kind-aware (a "de" node and a "journey" node with
  the same label are NOT duplicates)

New ops added for governance: `merge_nodes` and `supersede_rule` let
Claude consolidate duplicates that slipped through before dedup existed.

---

## 9. Context Loading & Bidirectional Sync

Context flows into Claude Code (external MCP path) through three
mechanisms working together.

### Active project follows the web app

Both the SessionStart hook and the MCP server look up the user's
**`org_members.active_workspace_id`** at startup. Switch projects in
the browser and the next Claude Code session sees the new project.

### Privacy default: writes off until "delma on" (external MCP only)

CLAUDE.md leads with a privacy contract for the external Claude Code path:

- **Reads always on.** Claude can see the workspace.
- **Writes OFF by default.** Enabled via "delma on" (creates `.claude/.delma-on`).

The in-app chat sidebar has **always-on writes** — no toggle needed.

### Session start: full content (via hook)

`hooks/load-workspace.sh` runs once at session start and loads the full
workspace content from Supabase. Claude has every detail before the
first message.

### Ongoing: summary in CLAUDE.md (auto-updated)

After every MCP write OR web app save, `refreshClaudeMd()` reads all
tabs, sends them to the summarizer (DeepSeek, Haiku fallback), and
writes a condensed summary to CLAUDE.md locally. Trigger points:
MCP writes and web app saves (via `POST /api/refresh-claude-md`).

### Per-message: smart hook (only when changed)

`hooks/inject-claude-md.sh` is a `UserPromptSubmit` hook. Before every
user message it checks CLAUDE.md mtime — if changed since last
injection, injects fresh content wrapped in `<delma-fresh-context>`.
Most messages: zero token cost (file unchanged).

### Net result

- **Claude -> Web app**: typed op -> Supabase -> Realtime push (instant)
- **Web app -> Claude**: Save -> server refreshes CLAUDE.md -> next
  message -> hook injects fresh content (~1-10s end-to-end)
- **Mid-session drift**: Claude can call `get_workspace_state` on demand

---

## 10. Web App Features

### Layout

Workspace on the left, chat sidebar on the right. The workspace UI is
vanilla JS (`src/main.js`). The chat sidebar is a React island
(`src/chat/`) mounted into a DOM node by `mountChat()`. This lets us
add React without rewriting the existing workspace renderer.

### Natural Language Editing — Typed-Op Router

All user input (proactive question answers + manual NL edits) flows
through a **typed-op router** that uses Claude Haiku 4.5 via the
`/api/chat` proxy.

1. The router sees all tabs with their **current structured JSON state**.
2. Returns typed operations as JSON:
   `[{ "tab": "org:people.md", "op": "add_person", "args": {...} }, ...]`
3. Web app POSTs each tab's ops to `/api/op` -> `applyOpsToTab()` ->
   mutates structured JSON -> re-renders content -> writes to Supabase.
4. Realtime pushes changes to all connected clients.

**Cost**: ~$0.001-0.003 per input (median ~800ms round-trip).

**Test harness**: `scripts/eval-router.js` runs scored cases against
the live prompt. `npm run eval:router`.

### Proactive Questions

DeepSeek analyzes tab content and surfaces questions about gaps.
Questions appear in a fixed action slot below the tab header.
Timing: first check 30s after load, then every 5 minutes.
Dismissed questions don't reappear for that tab.

### Mermaid Diagrams

Each tab type has its own shape + color + emoji vocabulary baked into
the router system prompt.

**Architecture** — Cylinders for DEs, hexagons for Automations, stadiums
for Journeys, parallelograms for Emails, trapezoids for CloudPages,
diamonds for Decisions. Light color tints per category. Emoji prefixes.
Layer subgraphs group nodes by role. Floating italic labels.

**People** — Shapes per role: rounded for ICs/managers, trapezoid for
stakeholders, cylinder for teams, parallelogram for vendors.

**Playbook** — Process steps, approval diamonds, wait hexagons, action
checkmarks, doc parallelograms, hard-rule diamonds with brand-red border.

### Real-time Sync

External writes (Claude via MCP or another browser tab) cause the
active tab to fade and re-render with a red border flash animation.
Inactive tabs show a dot indicator. If the user is in edit mode, a
status message appears instead of overwriting the editor.

---

## 11. Bidirectional Editing

Both Claude and the user write to the same Supabase tables. Supabase
Realtime pushes changes to all connected clients. No polling. No
manual refresh.

Conflict model: last-write-wins. History snapshots on every save make
any overwrite recoverable.

---

## 12. The Product Thesis

Delma is a **context layer that makes AI assistants usable by
non-technical people** on technical projects.

The PM doesn't need to be technical because Claude has the Environment
tab (every ID, every API endpoint) and the Decisions tab (every business
rule). The PM just says what they want in plain English. Claude does the
rest.

The workspace and memory aren't documentation — they're the **shared
truth** that makes this possible.

---

## 13. Observability

### Helicone (LLM calls)

All Anthropic API calls route through Helicone when `HELICONE_API_KEY`
is set (`server/lib/llm.js`). Every call is tagged with its surface
(critic, router, run-summary, narrative-sim, quality-layer) for
filtering in the Helicone dashboard. Logs latency, token usage, cost,
and full prompt/response.

### Console log prefixes

| Prefix | Layer | What it covers |
|--------|-------|----------------|
| `[delma init]` | Frontend | App startup, auth, workspace load |
| `[delma auth]` | Frontend | Login, signup, session check |
| `[delma workspace]` | Frontend | Open, refresh (timing + counts) |
| `[delma realtime]` | Frontend | Subscription setup, change handling |
| `[delma save]` | Frontend | Tab saves to Supabase |
| `[delma apply]` | Frontend | Apply flow (both NL edit + proactive) |
| `[delma render]` | Frontend | Diagram/markdown render |
| `[delma router]` | Frontend | Typed-op router |
| `[delma edit]` | Frontend | Manual NL edit entry point |
| `[delma onApply]` | Frontend | Proactive question answer entry point |
| `[delma reveal]` | Frontend | Hide / reveal cycle for tab content |
| `[quality]` | Server | Quality lab layers (L1-L5) |
| `[server]` | Server | Express endpoints |
| `[mcp]` | Server | All MCP tool calls with timing |
| `[delma-state]` | Server | Supabase CRUD operations |
| `[server] op:` | Server | /api/op typed-op application |

---

## 14. Structured Tabs (the architecture that beats prompt engineering)

**Principle**: the LLM never rewrites tab content. It picks one of a
small set of typed operations and fills 2-3 fields. Deterministic code
does the actual mutation and rendering.

### The three layers

| Layer | What it does | Cost when wrong |
|---|---|---|
| **Schema** (JSON in `structured` column) | Source of truth | Fix in code; data round-trips |
| **Renderer / op handlers** (`src/tab-ops.js`) | Pure functions: data <-> markdown | Fix in code; testable |
| **LLM** (Haiku via `/api/chat` or Agent SDK via chat or MCP) | Classify intent, fill 2-3 fields | Bounded — can only call known ops |

### File map

| File | Role |
|---|---|
| `src/tab-ops.js` | Schemas, renderers, op handlers (pure). Shared browser+node. |
| `src/router-prompt.js` | Compact system prompt that returns typed ops. |
| `src/extract-json-array.js` | Robust JSON-array parser (ignores trailing prose). |
| `server/lib/apply-op.js` | Reads row -> applies ops -> writes structured + content. |
| `server/lib/similarity.js` | Gemini embedding dedup (server-side, circuit breaker). |
| `server/lib/llm.js` | Centralized Anthropic/Helicone helper (URL + headers). |
| `server/index.js` -> `POST /api/op` | Web app endpoint for typed ops. |
| `server/mcp.js` | `delma_*` MCP tools — one per op. |
| `scripts/eval-router.js` | Scored eval cases. `npm run eval:router`. |
| `scripts/backfill-structured.js` | One-shot legacy markdown -> structured JSON. |

### Tab schemas

```
people.md      -> { people: [{id, name, role, kind, reports_to: [id]}] }
playbook.md    -> { rules: [{id, text, section?}] }
environment.md -> { entries: [{key, value, note?}] }
decisions.md   -> { decisions: [{id, text, owner?, superseded_by?}],
                    actions: [{id, text, owner?, due?, done}] }
my-notes.md    -> { text: string }
architecture   -> { prose, nodes: [{id, label, kind, note?, layer?}],
                    edges: [{from, to, label?}],
                    layers: [{id, label}] }
```

`structured` is the source of truth. `content` (markdown) is
regenerated from it on every write.

### Available ops per tab

```
people.md:      add_person, set_role, remove_person, add_reporting_line,
                remove_reporting_line, set_manager
playbook.md:    add_playbook_rule, remove_playbook_rule, supersede_rule
environment.md: set_environment_key, remove_environment_key
decisions.md:   add_decision, add_action, complete_action,
                complete_action_by_text, remove_decision, supersede_decision
my-notes.md:    append_my_note
architecture:   set_prose, add_node, set_node_label, set_node_note,
                set_node_kind, move_node_to_layer, remove_node,
                merge_nodes, add_edge, remove_edge, add_layer, remove_layer
```

### Three write paths, same handlers

- **Web NL router**: input -> Haiku returns `[{tab, op, args}]` ->
  `POST /api/op` -> `applyOpsToTab`
- **In-app chat**: user message -> Agent SDK -> internal MCP tool ->
  server-side `runOp` -> same `applyOpsToTab`
- **Claude Code (external)**: conversation -> picks a `delma_*` MCP
  tool -> server-side `runOp` -> same `applyOpsToTab`

All three end at the exact same pure functions in `src/tab-ops.js`.

---

## 15. Quality Lab

While David sleeps (midnight PT nightly), the server runs a
comprehensive end-to-end test pipeline. Findings persist to `quality_*`
tables and are visible publicly at **`/logs`**.

### Run structure

Every quality run is grouped into a `quality_runs` row
(`server/quality/run-tracker.js`). The /logs page renders one clickable
card per run with:
- Trigger type (smoke, overnight, manual)
- Narratives run and average scores
- Sonnet-generated "what to act on" summary

Two views: `/logs` (list of recent run cards) and `/logs?run=<id>`
(detail view for a single run).

### Headline job — replay-first, narrative-fallback

**REPLAY mode** (when >= 5 real `api_op_logs` from last 24h):
Pulls yesterday's actual router inputs + ops, reconstructs
before-state, re-applies, and has a Sonnet critic grade 1-5.

**NARRATIVE mode** (when production traffic is sparse):
Runs curated multi-turn conversation scripts
(`server/quality/narratives.js`) — each is a deliberate full-arc
workday with ground truth. A Haiku "Claude" decides which typed ops to
call per turn; the same `/api/op` code path applies them. Then:

1. **Sonnet critic** compares final state to expected outcome (quality score)
2. **Deterministic fidelity** (`server/quality/fidelity.js`) computes
   entity-level capture rate — extracts named entities from expected
   blocks AND user turns, matches against actual state. Stable across
   runs; separates real regressions from critic noise.
3. **Post-turn reflection** catches named objects the primary pass drops.

Per-narrative org isolation ensures no ghost data between test runs.

### Two timeliness modes

| Mode | What it measures | Source |
|------|------------------|--------|
| **A — "Claude was slow to call the tool"** | Messages before Claude acted | `conversation_ticks` joined to `mcp_call_logs` |
| **B — "Delma applied the op slowly"** | Server-side latency | `api_op_logs.duration_ms` |

### Supporting layers (always run nightly)

| Layer | What it does | Output table |
|-------|--------------|--------------|
| Regression evals | Canonical eval suite (`server/quality/eval-cases.js`) | `quality_eval_runs` |
| State hygiene | SQL checks: orphan nodes, overdue actions, unowned decisions, roleless people | `quality_state_checks` |
| Router signal mining | Clusters recent router calls, asks Sonnet what's missing | `quality_signals` |
| A/B leaderboard *(opt-in)* | Re-runs evals against alternate model+prompt combos | `quality_experiments` |

### Auto-growing eval suite

Every "missed" or "wrong" finding from the critic is auto-filed as a
`quality_candidate_evals` row. The /logs page exposes a review queue.
Promote strong ones to real cases; the regression suite grows from real
failures.

### CLI runners

```
npm run smoke                      # evals + 1 narrative (~40s)
npm run smoke -- --medium          # evals + 3 narratives (~3 min)
npm run smoke -- --full            # evals + ALL narratives (~12 min)
npm run smoke -- --evals           # regression evals only (~7s)
npm run overnight                  # fires prod server, returns immediately
npm run overnight -- --watch       # fires + polls until complete
```

### Keep-alive

`.github/workflows/keep-alive-overnight.yml` pings the Render app
every 3 min around midnight PT to prevent free-tier spin-down before
the in-app scheduler fires the overnight run.

### Files

| File | Role |
|---|---|
| `server/quality/runner.js` | Master entry: dispatches replay vs narrative + runs cheap layers |
| `server/quality/replay.js` | Replays real production ops with critic |
| `server/quality/narratives.js` | Curated full-arc conversation scripts + runner |
| `server/quality/fidelity.js` | Deterministic entity-level fidelity scoring |
| `server/quality/run-tracker.js` | Per-run grouping + Sonnet summaries |
| `server/quality/timeliness.js` | Two-mode latency analysis (no LLM) |
| `server/quality/eval-cases.js` | Canonical eval cases |
| `server/quality/logs-page.js` | `/logs` HTML renderer (server-side, no client JS) |
| `scripts/smoke.js` | Fast local iteration runner |
| `scripts/overnight.js` | Fire prod overnight pipeline |

---

## 16. Buy-Not-Build Stack

| Need | Solution | Why |
|------|----------|-----|
| Auth + DB + Realtime | Supabase | Managed Postgres, RLS, websocket push |
| LLM observability | Helicone | Latency, tokens, cost, full traces |
| Embeddings (dedup) | Gemini | Free tier, fast, good enough for short strings |
| Chat brain | Claude Agent SDK | Same capabilities as Claude Code |
| SFMC operations | sfmc-sdk (planned) | Typed SDK for Marketing Cloud |
| Hosting | Render | Free tier, auto-deploy from GitHub |

---

## 17. What's Shipped vs Planned

### Shipped

- In-app chat sidebar (Agent SDK + React island)
- All typed ops with handler-level dedup + semantic dedup
- Architecture tab ops (add/remove/merge nodes, edges, layers, cycle detection)
- merge_nodes and supersede_rule for governance
- Quality lab with per-run cards, fidelity scoring, post-turn reflection
- Helicone integration for all LLM calls
- Gemini embeddings for semantic dedup (with circuit breaker)
- smoke + overnight CLI runners
- GitHub Actions keep-alive for Render free tier
- Chat persistence (conversations + messages tables)
- SFMC credential schema (pgcrypto-encrypted, migration 017)
- SFMC audit log table

### Planned (not shipped yet)

- SFMC tool catalog (15+ ops via sfmc-sdk) — next session
- SFMC OAuth credential flow UI — next session
- Workspace switcher hidden (auto-create one per org) — decided, not implemented
- Quality lab migration to /api/chat/stream path — deferred
- Rate limiting middleware — migration exists, not wired
- assistant-ui upgrade for polished chat UI — installed (`@assistant-ui/react`), not yet used
