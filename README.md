# Delma

Delma is now a local sidecar for Claude Code, not a Claude wrapper.

Claude Code stays the main coding surface. Delma maintains project memory, versioned Mermaid views, and `CLAUDE.md` beside your repo so Claude can read and update that shared context while it works.

## What Delma owns

- `.delma/workspace.json` for diagram tabs like `Codebase`, `Org`, `Data Flows`, `Automations`, and `Current Work`
- `.delma/history/` snapshots every time a view is saved
- `.delma/*.md` memory files
- project-root `CLAUDE.md`, composed from the Delma workspace and memory files

## App surfaces

- `npm run dev`
  - Runs the local Delma UI and API server
  - Open a project, edit Mermaid views, inspect memory, and save snapshots

- `npm run start:mcp`
  - Runs the Delma MCP server over stdio
  - Claude Code should connect to this and call Delma tools while it works

## Claude Code setup

Copy `.mcp.json.example` into your Claude Code MCP config and adjust the path if needed.

Delma exposes tools for:

- opening a project
- reading Delma state
- listing and reading diagram views
- saving a diagram view
- appending memory notes
- recomposing `CLAUDE.md`
- listing history

## Running locally

```bash
npm install
npm run dev
```

In another terminal:

```bash
npm run start:mcp
```

Then point Claude Code at the Delma MCP server and let it update Delma as it learns about the project.
