# Delma

Delma is now a shared SFMC and Salesforce workspace sidecar for Claude Code, not a Claude wrapper.

Claude Code stays the main coding surface. Delma maintains shared operational memory, versioned Mermaid views, connections context, and `CLAUDE.md` so Claude can read and update that context while it works.

## What Delma owns

- `.delma/workspace.json` for the two core diagram tabs: `Architecture` and `Org`
- `.delma/history/` snapshots every time a view is saved
- `.delma/*.md` memory files
- project-root `CLAUDE.md`, composed from the Delma workspace and memory files

## App surfaces

- `npm run dev`
  - Runs the local Delma UI and API server
  - Open a workspace, edit Mermaid views, inspect memory, and save snapshots

- `npm run start:mcp`
  - Runs the Delma MCP server over stdio
  - Claude Code should connect to this and call Delma tools while it works

## Claude Code setup

Copy `.mcp.json.example` into your Claude Code MCP config and adjust the path if needed.

Delma exposes tools for:

- opening a workspace
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

Then point Claude Code at the Delma MCP server and let it update Delma as it learns about the client workspace, SFMC, Salesforce CRM, and any optional local assets.

## Personal login

Delma now supports a simple personal username/password gate for single-user use.

Current local login:

```bash
DELMA_USERNAME=david
```

The active password and session secret are stored in your local untracked `.env` file on this machine.

Base shape:

```bash
DELMA_USERNAME=david
DELMA_PASSWORD=choose_a_password
DELMA_SESSION_SECRET=choose_a_long_random_secret
```

If `DELMA_PASSWORD` is set, the app requires login both locally and on the hosted deployment. If it is not set, auth stays off.
