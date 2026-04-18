-- Seed Emory Healthcare / Birthday Campaign with the real content from the
-- all-salesforce-projects/birthday README. Idempotent — uses UPDATE on the
-- existing rows.

-- Constants for this seed. If you ever clone this file for a different
-- project, replace the IDs at the top.
\set project_id '''a1b2c3d4-0000-0000-0000-000000000001'''
\set org_id     '''58e43330-c76c-474c-b89e-7a2d606a4a61'''
\set user_id    '''dab61e85-4a99-4641-9b2d-957b12843f0a'''

-- ── Architecture diagram: real system flow from the README ──────────────────
UPDATE diagram_views
SET
  title = 'Project High Level',
  description = 'System flow and business rules for the SFMC Birthday Campaign.',
  summary = 'Emory Healthcare birthday campaign: daily birthday email → quiz → follow-up journey routing.',
  mermaid = $MERMAID$---
config:
  look: neo
  theme: neo
  layout: elk
---
flowchart TD
  subgraph source["Patient Source"]
    SF["Salesforce Health Cloud"]
    OPTIN["ENT.All_Patients_Opted_In<br/>(Shared DE, opted-in patients)"]
    SF -->|sync| OPTIN
  end

  subgraph daily["Daily Filter (5 AM CT)"]
    SQL["Birthday_Daily_Filter<br/>SQL Query"]
    AUTOMATION["Birthday_Daily_Send_Refresh<br/>Automation (PAUSED)"]
    SEND_DE["Birthday_Daily_Send<br/>(Sendable DE)"]
    AUTOMATION -->|runs| SQL
    SQL -->|18+, has email| SEND_DE
  end

  subgraph main_journey["Main Journey"]
    BDE["Birthday Daily Email Journey v2<br/>(ContactEvent trigger)"]
    EMAIL["brand_all_hbd_2026<br/>(Asset 264938, legacy 83005)"]
    BDE --> EMAIL
  end

  subgraph quiz["Quiz Landing"]
    CP["CloudPage 8085<br/>Birthday Quiz"]
    RESP_DE["birthday_quiz_responses<br/>(Answer1, ResultPath, ProcessedFlag)"]
    EMAIL -->|4 buttons → CloudPagesURL 8085| CP
    CP -->|writes response| RESP_DE
  end

  subgraph followup["Follow-Up Routing"]
    POLL["Follow-Up Entry Automation<br/>(polls responses)"]
    FJ["Birthday Quiz Follow-Up Journey v2<br/>(decision split on ResultPath)"]
    POLL --> FJ
  end

  subgraph branches["3 Follow-Up Journeys (3-touch each)"]
    HV["Heart & Vascular<br/>3 emails, 48h waits"]
    WS["Women's Services<br/>3 emails, 48h waits"]
    GEN["General / Brand<br/>3 emails, 48h waits"]
  end

  OPTIN --> AUTOMATION
  SEND_DE -->|journey entry| BDE
  RESP_DE --> POLL
  FJ -->|heart| HV
  FJ -->|womens| WS
  FJ -->|general<br/>(active + nutrition)| GEN
$MERMAID$,
  updated_at = now()
WHERE project_id = :project_id AND view_key = 'architecture';

-- ── environment.md — "Files Locations and Keys" tab ─────────────────────────
UPDATE memory_notes
SET
  content = $ENV$# Files Locations and Keys

## Business Unit
- **Parent BU MID:** 514018310
- **Enterprise instance:** Emory Healthcare
- **publicationListId:** 1209 (enterprise) / 1242 (Marketing BU — TSD 274063)

## Source Data
- **Shared DE:** `ENT.All_Patients_Opted_In`
  - External key: `A5BD1930-82C8-48EE-9353-A33F3E095594`
  - Synced from Salesforce Health Cloud, already filtered to opted-in
- **Related shared DEs:** `All_Patients` (`AE002690-9D1D-4C7E-A552-73368D303927`), `All_Consumers` (`F3A7A0BD-82E7-4FED-ABF6-9AA0E99D02B4`)

## Daily Send Pipeline
- **SQL Query:** `Birthday_Daily_Filter` (ID: `cbb76dd1-0bfd-4bbc-a05d-5b91e6984c43`)
  - Target: `Birthday_Daily_Send` (Overwrite), 18+, has email
- **Sendable DE:** `Birthday_Daily_Send`
  - External key: `birthday-daily-send-1775856643368`
  - Folder ID: 68744
- **Automation:** `Birthday_Daily_Send_Refresh` (ID: `11515afe-c5c3-4b6e-8005-f7e8c8a50a45`)
  - Schedule: Daily 5:00 AM CT — **NOT ACTIVATED**

## Testing DEs
- **Birthday_Test_Seed** (root level): key `birthday-test-seed-1776110854336`
  - Same schema as Birthday_Daily_Send. 7 rows seeded with today's birthdate.
- **Seed_List_Copy** (Shared Items > Marketing > Test Extension): existing, different schema
- **seedlist_2026_directmail_email** (Shared Items > Marketing > Test Extension): stakeholder pre-launch seed

## Main Journey
- **Birthday Daily Email Journey v2**
  - Journey ID: `d53b5e04-ec9a-4526-b05e-8b8bd0b6e746`
  - Journey Key: `birthday-daily-email-1776105623171`
  - Entry: `Birthday_Test_Seed` (test) → swap to `Birthday_Daily_Send` for go-live
  - Event def key: `ContactEvent-d3c7ed48-1809-303f-c8cf-c3fc8b6844e4`
  - Status: Published, test mode

## CloudPage (Quiz)
- **Page ID:** 8085
- **Asset ID:** 264940
- **Live URL:** https://mcvxtx2z6j0zm8sr3052pf8bh508.pub.sfmc-content.com/oijwc05lwal
- **Writes to:** `birthday_quiz_responses`

## Response DE
- **birthday_quiz_responses** (Data Extensions > JOURNEYS)
  - External key: `0C53F1BE-0AAB-4F7D-83C6-C743CAF1F1A8`
  - Folder ID: 76081
  - Fields: SubscriberKey (PK), Answer1, ResultPath, QuizName, SubmitDate, ProcessedFlag, FirstName, EmailAddress

## Follow-Up Journey
- **Birthday Quiz Follow-Up Journey v2**
  - Journey ID: `cb195f60-a163-4a5b-b4cc-2ecb6a62c485`
  - Journey Key: `birthday-quiz-followup-1776105548190`
  - Entry: `birthday_quiz_responses` (EmailAudience trigger)
  - Event def key: `DEAudience-f9617b8e-17a6-b57a-ff44-53476cd32441`
  - Wait steps: **5 min (test)** — change to 48 hours for production
  - Status: Published, test mode
- **Follow-Up Entry Automation:** `da6233dd-03cb-4d5c-941c-b06c4724af67` (daily 5 AM CT)
- **Annual clear automation:** `af328250-3721-4577-acfd-7d2bd57610a9` (clears responses every Jan 1)

## Email Assets (CB → Legacy ID)
| Email | CB Asset ID | Legacy ID | Customer Key |
|---|---|---|---|
| brand_all_hbd_2026 | 264938 | 83005 | 28f168b6-6cbd-4189-b4d8-3e615325fee7 |
| HV email 1 (restored) | 266829 | 83609 | 36b01908-fd99-49ed-911c-6ce5bdc1a78b |
| Brand welcome 1 (restored) | 266830 | 83610 | 53ee7edf-8875-4e56-99cb-44a269128e99 |
| Brand welcome 2 (restored) | 266832 | 83612 | 85848ca0-c7d4-40a9-a5a3-1d5730ba1f1e |
| Brand welcome 3 (restored) | 266831 | 83611 | ee6b4bca-8e7d-4089-9c13-8281859a4fa0 |
| hv_all_lead_nurture_email1 (orig) | 264537 | 82868 | 68f9c554-04bd-4162-b7b5-504fc98315a8 |
| hv_all_lead_nurture_email2 | 264538 | 82869 | c1ff103a-d9f1-4b41-be70-16c7b6a6a0f4 |
| hv_all_lead_nurture_email3 | 264540 | 82871 | 65f9e846-4f68-4ec7-917b-4a50db38d39c |
| draft_ws_journey_rebrand_email1 | 263305 | 82461 | 352b16d0-c16f-4339-9a51-d56c11c9c833 |
| draft_ws_journey_rebrand_email2 | 263314 | 82467 | 5bfef164-1333-40a6-94f4-5474780d6732 |
| draft_ws_journey_rebrand_email3 | 263313 | 82466 | a86328f4-1836-442f-a9ee-d265c6aced06 |

## Journey Send Configuration IDs (Emory instance, same across all journeys)
- sendClassificationId: `75cce2c9-641a-ec11-ba49-48df37e62332` (CustomerKey: "Default Commercial")
- deliveryProfileId: `74cce2c9-641a-ec11-ba49-48df37e62332`
- senderProfileId: `73cce2c9-641a-ec11-ba49-48df37e62332`

## API Access
- OAuth: SFMC Installed Package (Client ID/Secret in `.env`, not committed)
- REST base: `https://mcvxtx2z6j0zm8sr3052pf8bh508.rest.marketingcloudapis.com`
- SOAP base: `https://mcvxtx2z6j0zm8sr3052pf8bh508.soap.marketingcloudapis.com`

## Local Source Files (repo: all-salesforce-projects/birthday)
- `cloudpage-thankyou.html` — CloudPage source (AMPscript + HTML)
- `email-quiz-buttons.html` — 4 quiz buttons, page ID 8085 wired
- `birthday-email-current.html` — current email HTML pulled from SFMC
- `sql/daily-birthday-filter.sql` — daily query
- `scripts/` — create-triggered-sends, seed-test-emails, check-send-status, etc.
$ENV$,
  updated_at = now()
WHERE project_id = :project_id AND filename = 'environment.md';

-- ── decisions.md — "Project Details" tab ────────────────────────────────────
UPDATE memory_notes
SET
  content = $DEC$# Project Details

## Decisions
- **Cancer topic removed** from quiz buttons, CloudPage, and follow-up journey mapping. Keyona's call — not appropriate for lead nurture.
- **Source DE switched** from `All_Patients` to `ENT.All_Patients_Opted_In`. Cleaner — already filtered to opted-in, no opt-out check needed in SQL.
- **Wait steps set to 5 min** for test mode in follow-up journey. Change to 48 hours before go-live.
- **Publication list:** 1209 (enterprise) is default. TSD 274063 had its List.ID swapped to 1242 (Marketing BU) during April 2026 debugging — verify before go-live.
- **Follow-up emails restored as freeform HTML (assetType 208)** after April 2026 corruption of the original template-based assets (assetType 207). Do not PATCH 207 emails via REST API — it clears slot.content irreversibly. Rule: only PATCH specific fields, never spread a slot object.
- **Quiz writes directly to `birthday_quiz_responses`** from the CloudPage (AMPscript). No intermediate journey step.
- **3-touch follow-up per path.** Heart → HV, Women's → WS, Active + Nutrition → General/Brand.

## Actions (pre-launch)
1. **Point `Birthday_Daily_Filter` SQL to production source** — confirm `ENT.All_Patients_Opted_In` is the live DE reference and the filter is 18+ with email.
2. **Run `Birthday_Daily_Send_Refresh` manually once** to populate `Birthday_Daily_Send` with real birthdays.
3. **Swap entry source** in Journey Builder UI (Birthday Daily Email Journey v2): `Birthday_Test_Seed` → `Birthday_Daily_Send`. Must be done in UI — API can't update published journey.
4. **Change follow-up journey wait steps** from 5 minutes → 48 hours (all 6 wait steps).
5. **Activate `Birthday_Daily_Send_Refresh`** on daily 5 AM CT schedule.
6. **Activate `Follow-Up Entry Automation`** (`da6233dd-03cb-4d5c-941c-b06c4724af67`).
7. **Verify `Birthday_Quiz_Response_Annual_Clear`** (`af328250-3721-4577-acfd-7d2bd57610a9`) is active — clears responses every Jan 1 so contacts can re-enter next year.
8. **Verify publicationListId** — confirm 1209 works for production subscribers, or update to 1242 if needed.
9. **Soft launch** — start with patients whose LastName starts with 'A', then expand daily.

## Test Plan Status (as of April 2026)
- [x] CloudPage built, deployed, all 4 quiz paths tested
- [x] `Birthday_Test_Seed` seeded with 7 test addresses (pstrainer001-003, tolubeat, dropsong, wizflo, siliconbeach)
- [x] Both journeys Published in test mode
- [x] Render bug fixed — removed `CloudPagesURL(12345,...)` placeholder block from `brand_all_hbd_2026` (was causing silent send failure)
- [ ] Re-fire Step 1 — re-run automation to send birthday email to all 7 test addresses
- [ ] Steps 2–6 — quiz click → CloudPage → DE write → follow-up routing
- [ ] Stakeholder seed list send

## Bug Log (April 2026)
- **Render failure (resolved):** Birthday email had a leftover `CloudPagesURL(12345,...)` block alongside the real `CloudPagesURL(8085,...)` block. 7 contacts entered, 0 received emails — journey exited silently. Fix: removed the placeholder block. Preview and Test now passes. Always test email render first before debugging infrastructure.
- **`{name}` literal placeholders (resolved):** Some follow-up email body greetings used literal `{name}` instead of SFMC personalization. Correct AMPscript: `%%[VAR @fn SET @fn = ProperCase([FirstName]) IF Empty(@fn) THEN SET @fn = "there" ENDIF]%%Hi %%=v(@fn)=%%,`
- **Asset corruption (resolved):** A PATCH with JavaScript spread operator on assetType 207 template emails cleared `slot.content` on 4 emails. Recovery path: exported original HTML from delivered `.eml`, created new freeform (assetType 208) assets, swapped legacy IDs via Journey Builder UI.
$DEC$,
  updated_at = now()
WHERE project_id = :project_id AND filename = 'decisions.md';

-- ── Set this project as dzernik's active one ─────────────────────────────────
UPDATE org_members
SET active_project_id = :project_id
WHERE org_id = :org_id AND user_id = :user_id;

SELECT 'seed complete' AS status;
