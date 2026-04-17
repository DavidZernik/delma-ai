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

**Project:** Emory Healthcare - Birthday Campaign  
**Team:** David Zernik (Lead), Keyona Abbott (Stakeholder)  
**Status:** Built in SFMC, in final testing. Main automation (`Birthday_Daily_Send_Refresh`) is paused. Follow-up journey uses 5-minute test waits.  

**Key Systems/IDs:**  
*   **Source:** `ENT.All_Patients_Opted_In` (A5BD1930-82C8-48EE-9353-A33F3E095594)  
*   **Automation:** `Birthday_Daily_Send_Refresh` (11515afe-c5c3-4b6e-8005-f7e8c8a50a45) - Daily 5 AM CT, paused.  
*   **Query:** `Birthday_Daily_Filter` (cbb76dd1-0bfd-4bbc-a05d-5b91e6984c43)  
*   **Journeys:** Main `Birthday Daily Email` (d53b5e04-ec9a-4526-b05e-8b8bd0b6e746), Follow-up `Birthday Quiz Follow-Up` (cb195f60-a163-4a5b-b4cc-2ecb6a62c485).  
*   **Email:** `brand_all_hbd_2026` (264938).  
*   **CloudPage:** 8085 (264940).  
*   **Data Extensions:** Staging `TEST_Birthday_Daily_Send`; Response `birthday_quiz_responses` (0C53F1BE-0AAB-4F7D-83C6-C743CAF1F1A8).  

**Next Actions:**  
1.  Point filter query to production source DE (`ENT.All_Patients_Opted_In`).  
2.  Change follow-up journey wait steps from 5 minutes to 48 hours.  
3.  Activate the main daily automation on schedule.  
4.  Execute soft launch (start with LastName A%).
