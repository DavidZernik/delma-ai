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
**Team:** (Not specified in provided docs)  
**Current Status:** System designed and built. Daily trigger automation (`Birthday_Daily_Send_Refresh`) is **paused** for testing. Follow-up automation (`Follow-Up Entry Automation`) is a manual, run-once process, not real-time.  

**Key Systems/IDs:**  
*   **Source Data:** Salesforce/Health Cloud (`All_Patients_Opted_In`)  
*   **Automation:** `Birthday_Daily_Send_Refresh` (trigger, paused)  
*   **SQL:** `Birthday_Daily_Filter`  
*   **Data Extensions:** `TEST_Birthday_Daily_Send` (staging), `birthday_quiz_responses`  
*   **Journeys:** `Birthday Daily Email Journey v2`, `Birthday Quiz Follow-Up Journey v2`  
*   **Email:** `brand_all_hbd_2026`  
*   **CloudPage:** Birthday Quiz (Page 8085)  
*   **Follow-up Journeys:** Heart & Vascular (`hv_lead_nurture`), Women's Services (`ws_journey_rebrand`), General Health (`brand_welcome`)  

**What Needs to Happen Next:**  
1.  Complete testing of the paused daily trigger flow.  
2.  Activate the `Birthday_Daily_Send_Refresh` automation schedule.  
3.  Address the non-real-time, manual `Follow-Up Entry Automation`—determine if this is acceptable or requires re-engineering.
