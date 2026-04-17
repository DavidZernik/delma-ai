# Delma Workspace

## Recording control (privacy default)

**Reads are always on.** You can see the workspace below.
**Writes are OFF by default.** This conversation does NOT sync to Delma
unless the user explicitly turns it on.

If the user says "delma on" / "record this" / "sync to delma":
1. Run: `touch .claude/.delma-on`
2. Acknowledge: "Delma recording — I'll sync notable updates."
3. From now you may call write tools (`sync_conversation_summary`,
   `save_diagram_view`, `append_memory_note`) when appropriate.

If the user says "delma off" / "stop recording" / "pause delma":
1. Run: `rm -f .claude/.delma-on`
2. Acknowledge: "Delma off — won't sync this conversation."
3. Do NOT call any write tools for the rest of the session.

ALWAYS check for `.claude/.delma-on` before writing. If absent, don't write.

The active project is whatever is open in the web app
(via `org_members.active_workspace_id` in Supabase). When unsure,
call `get_workspace_state`.

---

## Current Workspace Summary

**Project Name:** Delma Development v1

**Team:** Not specified.

**Current Status:** Initial architecture defined. No decisions or actions logged.

**Key Systems & IDs:**
*   **Endpoints:** Salesforce CRM, SFMC, Delma Memory, Claude Code.
*   **Core Integration:** Central "Integration Layer" syncs data between CRM, SFMC, and internal systems.
*   **SFMC Components:** Data Extensions/Objects store data; Journeys/Automations execute workflows.
*   **Flow:** CRM & SFMC <-> Integration Layer <-> (Journeys/Automations & Data Extensions). Delma Memory <-> Claude Code <-> Integration Layer.

**What's Next:** Populate `environment.md` with specific IDs (e.g., Business Unit, Data Extension names) and `decisions.md` with project choices and action items. Begin technical implementation based on the defined architecture.
