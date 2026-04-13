# Delma Live — the product that exists now

This is the canonical reference for the product as it exists in the
repo today.

Read this if you want to understand:
- what Delma is right now
- what the web app shows and does
- how the MCP server works and what tools it exposes
- how the workspace and memory files are structured
- why bidirectional editing is the core design constraint
- where the value already lives without any wrapper

For future features and product direction, see `docs/future.md`.

---

## 1. What Delma is right now

> **Delma is a persistent visual workspace for Claude Code: a web app
> that keeps your system map, diagrams, and project memory visible
> while Claude works — and updates live as Claude writes to it.**

The live product has three jobs:

- keep the shared workspace map visible beside Claude Code at all times
- give Claude Code a structured memory it can read from and write to via MCP
- update the visual layer in real time when Claude makes changes

This is not a chat interface. Claude Code is the agent. Delma is the
map it works from.

---

## 2. The Live Product At A Glance

```mermaid
flowchart TB
  subgraph inputs["INPUTS — what Delma holds"]
    direction TB

    workspace["🗺️ Workspace views<br/><br/>Architecture and Org Chart diagrams.<br/>Each view has a title, description, summary,<br/>and Mermaid source. Stored in .delma/workspace.json."]

    memory["🧠 Memory files<br/><br/>Four structured markdown files:<br/>environment.md, logic.md, people.md, session-log.md.<br/>Stored in .delma/ alongside the workspace."]

    history["🕓 Snapshot history<br/><br/>Timestamped JSON snapshots written on every save.<br/>Stored in .delma/history/.<br/>Automatic — no manual versioning needed."]
  end

  subgraph mcp["MCP SERVER — how Claude Code connects"]
    direction TB

    tools["🔧 MCP tools<br/><br/>open_project, get_delma_state, list_diagram_views,<br/>get_diagram_view, save_diagram_view,<br/>append_memory_note, compose_claude_md, list_history."]

    claudemd["📄 CLAUDE.md generation<br/><br/>On every write, Delma regenerates CLAUDE.md<br/>from views + memory files and writes it to the repo root.<br/>Claude Code loads it automatically every session."]
  end

  subgraph surface["WEB APP — what the user sees"]
    direction TB

    webapp["🖥️ Left panel web app<br/><br/>Three tabs: Architecture, Org Chart,<br/>High Level Project Details.<br/>View and Edit modes per tab."]

    live["⚡ Live updates<br/><br/>WebSocket connection between MCP writes<br/>and the web app. Diagrams re-render<br/>when Claude saves a view."]

    auth["🔐 Auth<br/><br/>Username + password session auth.<br/>Cookie-based. Optional — disabled if no<br/>DELMA_PASSWORD env var is set."]
  end

  inputs --> mcp
  mcp --> surface

  classDef rich font-size:11px,text-align:left
  class workspace,memory,history,tools,claudemd,webapp,live,auth rich
  style tools fill:#fef3c7,stroke:#f59e0b,stroke-width:3px
  style webapp fill:#dbeafe,stroke:#2563eb,stroke-width:3px
  style claudemd fill:#dcfce7,stroke:#16a34a,stroke-width:3px
```

---

## 3. What the Web App Shows

The left panel is the center of the live product.

It should feel like a live project dashboard, not a static doc.

The user should always be able to answer:

- what does this system look like right now
- what does the org or team structure look like
- what is the top-level status and what remains

That means three tabs, always visible, even before a workspace is loaded:

```mermaid
flowchart TB
  tab1["1. Architecture<br/><br/>Mermaid diagram of how systems, code assets,<br/>integrations, and automation surfaces connect.<br/>View mode renders the diagram. Edit mode shows raw Mermaid."]

  tab2["2. Org Chart<br/><br/>Mermaid diagram of the human org:<br/>stakeholders, owners, decision-makers, trust boundaries.<br/>Same View / Edit toggle as Architecture."]

  tab3["3. High Level Project Details<br/><br/>Generated from all view summaries + memory files.<br/>Prose reference Claude Code reads as context.<br/>Edit mode exposes the raw markdown."]

  tab1 --> tab2 --> tab2
  tab2 --> tab3

  classDef rich font-size:11px,text-align:left
  class tab1,tab2,tab3 rich
  style tab1 fill:#ffffff,stroke:#111827,stroke-width:1px
  style tab2 fill:#f9fafb,stroke:#111827,stroke-width:1px
  style tab3 fill:#f3f4f6,stroke:#111827,stroke-width:2px
```

The View / Edit toggle is global — switching modes applies to all three
tabs, not just the active one. Switching tabs preserves the current mode
and saves any edits in progress.

---

## 4. The MCP Server Tools

The MCP server runs locally via `npm run start:mcp` (stdio transport).
Claude Code connects to it via `.mcp.json`.

```mermaid
flowchart TB
  r1["open_project<br/><br/>Set the active project directory.<br/>Initializes .delma/ state if not present."]
  r2["get_delma_state<br/><br/>Read full workspace, memory files, graph,<br/>and snapshot history in one call."]
  r3["list_diagram_views<br/><br/>List available views with id, title, kind,<br/>description, and summary."]
  r4["get_diagram_view<br/><br/>Read one view by id, including full Mermaid source."]
  r5["save_diagram_view<br/><br/>Update a view's title, description, summary, or Mermaid.<br/>Writes a history snapshot and regenerates CLAUDE.md."]
  r6["append_memory_note<br/><br/>Append a note (with optional heading) to one<br/>of the four memory markdown files.<br/>Regenerates CLAUDE.md."]
  r7["compose_claude_md<br/><br/>Regenerate CLAUDE.md from current views + memory.<br/>Called automatically by save_diagram_view and append_memory_note."]
  r8["list_history<br/><br/>List timestamped workspace snapshot files<br/>in .delma/history/."]

  r1 --> r2 --> r3 --> r4 --> r5 --> r6 --> r7 --> r8

  classDef rich font-size:11px,text-align:left
  class r1,r2,r3,r4,r5,r6,r7,r8 rich
  style r5 fill:#E1F5EE,stroke:#0F6E56,stroke-width:3px
  style r6 fill:#E1F5EE,stroke:#0F6E56,stroke-width:3px
  style r7 fill:#E1F5EE,stroke:#0F6E56,stroke-width:2px
```

---

## 5. The Workspace and Memory Structure

Every project Delma connects to gets a `.delma/` folder at its root.

```
.delma/
├── workspace.json       # Views: Architecture, Org Chart (titles, descriptions, Mermaid)
├── environment.md       # Tech stack, asset IDs, infrastructure, key identifiers
├── logic.md             # Business logic, routing, architecture decisions
├── people.md            # Ownership, stakeholders, tribal knowledge
├── session-log.md       # Status, what's done, what remains
├── CLAUDE.md            # Generated. Do not edit directly.
└── history/
    └── <timestamp>--<reason>.json   # Snapshot on every save
```

`CLAUDE.md` is regenerated on every write. It combines all view
summaries and memory file contents into a single file that Claude Code
loads automatically as project context each session.

This is the always-loaded cell of the memory grid. Claude Code sees the
full workspace state before the first message, every time.

---

## 6. Bidirectional Editing

Both Claude and the user are write-heads into the same `.delma/` files.
Neither owns the store — both can update it, and the diagram re-renders
either way.

**How it works:**

- User edits Mermaid directly in the web UI → saves → diagram re-renders
- Claude calls `save_diagram_view` or `append_memory_note` via MCP → files change →
  `fs.watch` detects the change → broadcasts via `/ws/live` WebSocket →
  browser calls `refreshWorkspace()` → diagram re-renders live

No polling. No manual refresh. Both write sources converge on the same
`.delma/` files as the single source of truth.

**Conflict model (V1):** last-write-wins. This is a single-user tool and
the conflict window is tiny. A history snapshot is written on every save,
so any overwrite is recoverable.

**Mermaid is the format.** It's human-readable enough to edit by hand and
machine-readable enough for Claude to write directly. No separate
markdown-to-diagram parser is needed.

---

## 7. MCP Call Logger

Every MCP tool call is logged to `.delma/mcp-calls.jsonl`
(newline-delimited JSON). Each line contains:

```json
{
  "timestamp": "2026-04-13T14:22:01.123Z",
  "tool": "append_memory_note",
  "input": { "file": "people.md", "note": "..." },
  "durationMs": 42,
  "success": true,
  "error": null
}
```

This log is the raw material for the analyzer app — it captures when
Claude calls MCP tools, what triggered the call, and how long it took.
It is excluded from `fs.watch` broadcasts so it doesn't cause UI
re-renders.

---

## 8. Claude Auto-Update Behavior

The generated `CLAUDE.md` includes explicit instructions telling Claude
to call MCP tools automatically during conversations — without being asked.

**Rules embedded in CLAUDE.md:**

- Call `get_delma_state` at the start of each conversation
- Call `append_memory_note` when the user confirms a fact about a person,
  role, ownership, or decision
- Call `save_diagram_view` when a structural relationship changes
- Only write what the user has explicitly stated or confirmed — never infer
- Batch updates: one call with all facts learned, not one call per fact

The CLAUDE.md is regenerated on every MCP write, so these instructions
are always current and always loaded.

---

## 9. Mermaid Error Handling

If a diagram has invalid Mermaid syntax:

- **In view mode:** the diagram area shows a styled error with the
  specific syntax problem
- **Before saving:** the save button validates first — broken Mermaid
  is blocked from saving with a status message explaining why
- **Recovery:** the last valid snapshot is always in `.delma/history/`

---

## 10. The Live Product Thesis

The live product is the MCP memory server plus the visual workspace layer
that makes it observable, bidirectional, and live.

In one sentence:

> **Delma is the persistent project memory Claude Code reads from and
> writes to — made visible as a live map you keep open beside your work,
> that both you and Claude can edit.**
