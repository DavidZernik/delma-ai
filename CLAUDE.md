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

**Team Members & Roles:**
*   **Marketing Automation Team:** Builds/maintains SFMC journeys, automations, and data flows.
*   **Data/CRM Team:** Manages source patient data in Salesforce Health Cloud.

**Current Status:** System is designed and documented. Core daily send automation (`Birthday_Daily_Send_Refresh`) is **paused for testing**. Follow-up automation (`Follow-Up Entry Automation`) is a manual, run-once process, not real-time.

**Key Systems/IDs:**
*   **Source:** Salesforce Health Cloud `All_Patients_Opted_In` DE.
*   **Filter:** SQL `Birthday_Daily_Filter`.
*   **Staging DE:** `TEST_Birthday_Daily_Send`.
*   **Journeys:** `Birthday Daily Email Journey v2` (main), `Birthday Quiz Follow-Up Journey v2` (routing).
*   **Email:** `brand_all_hbd_2026`.
*   **CloudPage:** Birthday Quiz (Page 8085).
*   **Response DE:** `birthday_quiz_responses` (stores `Answer1`, `ResultPath`, `ProcessedFlag`).
*   **Follow-up Journeys:** `Heart & Vascular` (hv_lead_nurture), `Women's Services` (ws_journey_rebrand), `General Health` (brand_welcome).

**What Needs to Happen Next:**
1.  **Testing:** Execute end-to-end test of the paused daily send flow.
2.  **Automation Optimization:** Address the manual, non-real-time nature of the `Follow-Up Entry Automation`.
3.  **Monitoring:** Establish process to monitor the `birthday_quiz_responses` DE and journey performance post-launch.
