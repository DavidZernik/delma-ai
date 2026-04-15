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
**Team:** Marketing Automation Team (Owner: Delma)  

**Current Status:** Ready for end-to-end testing. Both journeys (Birthday Daily Email & Birthday Quiz Follow-Up) are Published. 7 test contacts are seeded. The daily automation is built but not activated.

**Key Systems/IDs:**
*   **Source DE:** `All_Patients_Opted_In` (Shared)
*   **Trigger Automation:** `Birthday_Daily_Send_Refresh` (ID: `11515afe-c5c3-4b6e-8005-f7e8c8a50a45`)
*   **Staging DE:** `TEST_Birthday_Daily_Send`
*   **Main Journey:** `Birthday Daily Email` (ID: `d53b5e04-ec9a-4526-b05e-8b8bd0b6e746`)
*   **Birthday Email:** `brand_all_hbd_2026` (Asset ID: `264938`)
*   **Quiz CloudPage:** Page ID `8085`
*   **Response DE:** `birthday_quiz_responses`
*   **Follow-up Journey:** `Birthday Quiz Follow-Up` (ID: `cb195f60-a163-4a5b-b4cc-2ecb6a62c485`)
*   **Test Seed DE:** `Birthday_Test_Seed`

**What Needs to Happen Next (Immediate):**
1.  **Fire test contacts** into the Birthday Daily Email journey via Fire Event API (rows in the DE do not auto-trigger).
2.  Verify all 7 test addresses receive the birthday email.
3.  Click each quiz button (Heart, Womens, Active, Nutrition) from different emails.
4.  Confirm the CloudPage displays correctly and writes to `birthday_quiz_responses`.
5.  Verify follow-up emails are routed and sent correctly (wait steps are set to 5 minutes for testing).
6.  Check that the `ProcessedFlag` in the response DE flips to 'Y'.

**Pre-Launch Sequence:** After testing, manually run automation, swap journey entry source to production DE, reset wait steps to 48 hours, activate the daily automation schedule, and activate journeys on the real source.
