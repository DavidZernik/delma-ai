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
**Team:** David Zernik (Marketing Automation), Keyona Abbott (Strategy)  
**Current Status:** Built in SFMC, in final testing. Main automation is paused. Follow-up journey uses 5-minute test waits.  

**Key Systems/IDs:**  
- **Source:** Salesforce Health Cloud → DE `ENT.All_Patients_Opted_In` (MID 514018310).  
- **Daily Automation:** `Birthday_Daily_Send_Refresh` (ID 11515afe-c5c3-4b6e-8005-f7e8c8a50a45) – runs 5 AM CT, currently paused.  
- **SQL Query:** `Birthday_Daily_Filter` (ID cbb76dd1-0bfd-4bbc-a05d-5b91e6984c43) filters to today’s birthdays.  
- **Staging DE:** `TEST_Birthday_Daily_Send`.  
- **Main Journey:** `Birthday Daily Email Journey v2` (ID d53b5e04-ec9a-4526-b05e-8b8bd0b6e746) sends email `brand_all_hbd_2026`.  
- **CloudPage:** ID 8085 captures quiz answer to DE `birthday_quiz_responses`.  
- **Follow-up Automation:** `Follow-Up Entry Automation` polls response DE and injects into `Birthday Quiz Follow-Up Journey v2` (ID cb195f60-a163-4a5b-b4cc-2ecb6a62c485).  
- **Routing:** Split by `ResultPath` to Heart & Vascular, Women’s Services, or General Health nurture streams.  

**Next Actions:**  
1. Switch SQL query source to production DE `ENT.All_Patients_Opted_In`.  
2. Change follow-up journey wait steps from 5 minutes to 48 hours.  
3. Activate the `Birthday_Daily_Send_Refresh` automation on schedule (target 10 AM CT).  
4. Execute soft launch: begin with patients whose LastName starts with 'A', then expand daily.  

**Note:** Cancer topic removed from quiz per strategy. API access requires Parent BU credentials (MID 514018310).
