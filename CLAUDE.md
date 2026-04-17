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

**PROJECT:** Emory Healthcare - Birthday Campaign  
**TEAM:** Keyona Abbott (Manager/PM), David Zernik (SFMC Architect)  
**STATUS:** Development/Testing. Core journeys built & published (v1). Main daily automation is paused. Follow-up journey uses 5-min test waits.  

**KEY SYSTEMS/IDs:**  
*   **Source:** `ENT.All_Patients_Opted_In` (Salesforce Health Cloud sync).  
*   **Automation:** `Birthday_Daily_Send_Refresh` (ID: 11515afe...), scheduled 5 AM CT, currently paused.  
*   **SQL Query:** `Birthday_Daily_Filter` (ID: cbb76dd1...).  
*   **Journeys:** Main `Birthday Daily Email` (ID: d53b5e04...). Follow-up `Birthday Quiz Follow-Up` (ID: cb195f60...).  
*   **Assets:** Email `brand_all_hbd_2026`. CloudPage `8085`. Response DE `birthday_quiz_responses`.  
*   **Parent BU MID:** `514018310` (for API access to synced DEs).  

**NEXT ACTIONS:**  
1.  Point SQL filter to production source DE (`ENT.All_Patients_Opted_In`).  
2.  Change follow-up journey wait steps from 5 minutes to 48 hours.  
3.  Activate the `Birthday_Daily_Send_Refresh` automation on schedule.  
4.  Execute soft launch (start with LastName A%, expand daily).  

**RULES:** No Friday launches. Legal review required. Seed test with Keyona first. Document decisions in Slack.
