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

**Project Name:** Emory Healthcare Birthday Campaign  
**Team:** Not specified in workspace.  
**Current Status:** System designed and documented. Core automation (`Birthday_Daily_Send_Refresh`) is on a **PausedSchedule during testing**.  

**Key Systems/IDs:**
*   **Source Data:** Salesforce/Health Cloud (`All_Patients_Opted_In` DE)
*   **Automation:** `Birthday_Daily_Send_Refresh` (runs 5 AM CT)
*   **SQL:** `Birthday_Daily_Filter`
*   **Staging DE:** `TEST_Birthday_Daily_Send`
*   **Journey (Main):** `Birthday Daily Email Journey v2` (AutomationAudience entry)
*   **Email:** `brand_all_hbd_2026`
*   **CloudPage:** Birthday Quiz (Page 8085)
*   **Response DE:** `birthday_quiz_responses`
*   **Automation (Follow-up):** `Follow-Up Entry Automation` (runOnce, not real-time)
*   **Journey (Follow-up):** `Birthday Quiz Follow-Up Journey v2` (DEAudience entry)
*   **Follow-up Paths:** Split by `ResultPath` to `Heart & Vascular`, `Women's Services`, or `General Health` nurture journeys.

**What Needs to Happen Next:**
1.  Complete testing.
2.  Remove the **PausedSchedule** from the `Birthday_Daily_Send_Refresh` automation to activate the daily send.
3.  Ensure the `Follow-Up Entry Automation` is scheduled to run periodically to process quiz responses.
