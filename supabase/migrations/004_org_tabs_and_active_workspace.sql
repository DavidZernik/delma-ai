-- Delma v2.3: Org-level tabs + active workspace tracking
-- ──────────────────────────────────────────────────────────────────────────────
--
-- Two changes:
--
-- 1. Org-level memory notes — shared across all workspaces in the org.
--    Used for: SFMC Setup (credentials, send config, shared DEs, BU structure)
--              People (same team regardless of project)
--    These live in org_memory_notes, not memory_notes.
--
-- 2. Active workspace tracking — each user has a "last opened" workspace
--    per org. The hook reads this to auto-load the right project.
--

-- ── Org-level memory notes ───────────────────────────────────────────────────
-- Same structure as memory_notes but scoped to org, not workspace.
CREATE TABLE IF NOT EXISTS org_memory_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  filename text NOT NULL,
  content text DEFAULT '',
  permission text NOT NULL DEFAULT 'edit-all'
    CHECK (permission IN ('private', 'view-all', 'edit-all', 'view-admins')),
  owner_id uuid REFERENCES auth.users(id),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(org_id, filename, owner_id)
);

CREATE INDEX IF NOT EXISTS idx_org_memory_notes_org ON org_memory_notes(org_id);

-- Auto-update timestamp
CREATE TRIGGER set_updated_at BEFORE UPDATE ON org_memory_notes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE org_memory_notes;

-- RLS
ALTER TABLE org_memory_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view org notes" ON org_memory_notes
  FOR SELECT USING (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
    AND (
      permission = 'edit-all'
      OR permission = 'view-all'
      OR (permission = 'private' AND owner_id = auth.uid())
      OR (permission = 'view-admins' AND org_id IN (
        SELECT org_id FROM org_members WHERE user_id = auth.uid() AND role = 'admin'
      ))
    )
  );

CREATE POLICY "Org members can insert org notes" ON org_memory_notes
  FOR INSERT WITH CHECK (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Permission-aware edit org notes" ON org_memory_notes
  FOR UPDATE USING (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
    AND (
      permission = 'edit-all'
      OR (permission IN ('private', 'view-all') AND owner_id = auth.uid())
      OR (permission = 'view-admins' AND org_id IN (
        SELECT org_id FROM org_members WHERE user_id = auth.uid() AND role = 'admin'
      ))
    )
  );

-- ── Active workspace tracking ────────────────────────────────────────────────
-- Tracks which workspace each user last opened, per org.
-- The hook reads this instead of a hardcoded env var.
ALTER TABLE org_members
  ADD COLUMN IF NOT EXISTS active_workspace_id uuid REFERENCES workspaces(id);

-- ── Seed Emory org-level tabs ────────────────────────────────────────────────

-- SFMC Setup (org-level) — credentials, send config, shared DEs
INSERT INTO org_memory_notes (org_id, filename, content, permission, owner_id)
VALUES (
  '58e43330-c76c-474c-b89e-7a2d606a4a61',
  'sfmc-setup.md',
  '# SFMC Setup

<details>
<summary>API Credentials</summary>

- **Client ID:** `49ovkhiaawwkze9whtysgvz0`
- **Client Secret:** `KklesXxukpIFCtH2ofEyACAV`
- **Subdomain:** `mcvxtx2z6j0zm8sr3052pf8bh508`
- **Auth URL:** `https://mcvxtx2z6j0zm8sr3052pf8bh508.auth.marketingcloudapis.com/v2/token`
- **REST Base:** `https://mcvxtx2z6j0zm8sr3052pf8bh508.rest.marketingcloudapis.com`
- **SOAP URL:** `https://mcvxtx2z6j0zm8sr3052pf8bh508.soap.marketingcloudapis.com/Service.asmx`

</details>

## BU Structure
- **Parent BU:** Emory Healthcare
- **Working BU:** Marketing
- Use `ENT.` prefix in SQL for shared DEs

<details>
<summary>Send Configuration (same for all journeys)</summary>

- sendClassificationId: `75cce2c9-641a-ec11-ba49-48df37e62332`
- deliveryProfileId: `74cce2c9-641a-ec11-ba49-48df37e62332`
- senderProfileId: `73cce2c9-641a-ec11-ba49-48df37e62332`
- publicationListId: `1209`

</details>

## Shared Data Extensions
These are synced from Salesforce Health Cloud. Same across all campaigns.

| DE | Key |
|---|---|
| All_Patients_Opted_In | `A5BD1930-82C8-48EE-9353-A33F3E095594` |
| All_Patients | `AE002690-9D1D-4C7E-A552-73368D303927` |
| All_Consumers | `F3A7A0BD-82E7-4FED-ABF6-9AA0E99D02B4` |

<details>
<summary>API Reference</summary>

**Auth:**
```
POST https://{subdomain}.auth.marketingcloudapis.com/v2/token
{ "grant_type": "client_credentials", "client_id": "...", "client_secret": "..." }
```

**Fire Event (inject contact into journey):**
```
POST /interaction/v1/events
{ "ContactKey": "...", "EventDefinitionKey": "...", "Data": { ... } }
```

**Read DE rows:** `POST /data/v1/customobjectdata/key/{deKey}/rowset`

**Journey status:** `GET /interaction/v1/interactions/{journeyId}`

**Search assets:** `GET /asset/v1/content/assets?$filter=name like ''...''`

</details>

<details>
<summary>API Gotchas</summary>

- **TriggeredSendDefinition via SOAP:** Use `AutoAddSubscribers: false`, `SendClassification CustomerKey: "Default Commercial"`, and legacy email IDs
- **SOAP "already exists":** Returns error, not existing ID. Retrieve by CustomerKey.
- **ContactEvent vs AutomationAudience:** ContactEvent needs Fire Event API or automation run. Rows alone don''t fire.
- **EmailAudience:** Fires automatically when CloudPage writes to the DE.
- **Email publishing:** PATCH returns 200 but doesn''t change status. May require UI.
- **Journey status:** Always GET the journey directly. Don''t use stored publishAsync request IDs.

</details>
',
  'view-admins',
  'dab61e85-4a99-4641-9b2d-957b12843f0a'
);

-- People (org-level) — same team across all projects
INSERT INTO org_memory_notes (org_id, filename, content, permission, owner_id)
VALUES (
  '58e43330-c76c-474c-b89e-7a2d606a4a61',
  'people.md',
  '# People

## Team Structure

```mermaid
---
config:
  look: neo
  theme: neo
  layout: elk
---
flowchart TD
  David["David — SFMC Architect"] --> Keyona["Keyona — Creative / Email"]
  David --> PM["PM / Stakeholders"]
  Keyona --> GoLive["Go-Live Approval"]
  PM --> GoLive
```

## David (SFMC Architect)
Builds and maintains all technical pieces: automations, SQL queries, journeys, CloudPages, deploy scripts. Owns go-live checklists and testing.

## Keyona (Creative / Email)
Designs email creative. Created the quiz_responses DE for the birthday project. Provides image assets. Made the call to remove cancer from the quiz.

## PM / Stakeholders
Approve before anything goes live. May want a seed list send before full activation.
',
  'edit-all',
  'dab61e85-4a99-4641-9b2d-957b12843f0a'
);

-- Now remove people.md and the org-level parts of environment.md from the
-- workspace-level memory_notes (they now live at org level)
DELETE FROM memory_notes
WHERE workspace_id = 'a1b2c3d4-0000-0000-0000-000000000001'
  AND filename = 'people.md';

-- Update environment.md to be project-specific only (remove SFMC Setup stuff)
UPDATE memory_notes SET
  filename = 'project-details.md',
  content = '# Project Details

## The Birthday Email
- **Name:** brand_all_hbd_2026
- **Location:** Content Builder > Journeys > Brand
- **Asset ID:** 264938
- **Customer Key:** 28f168b6-6cbd-4189-b4d8-3e615325fee7

## CloudPage
- **Name:** Birthday Quiz
- **Page ID:** 8085
- **Live URL:** https://mcvxtx2z6j0zm8sr3052pf8bh508.pub.sfmc-content.com/oijwc05lwal
- **Asset ID:** 264940

## Campaign Data Extensions

### Birthday_Daily_Send
Today''s birthday patients. Rebuilt every morning.
- **Key:** `birthday-daily-send-1775856643368`
- **Location:** Data Extensions (root level)

### birthday_quiz_responses
Stores quiz answers. Entry source for follow-up journey.
- **Key:** `0C53F1BE-0AAB-4F7D-83C6-C743CAF1F1A8`
- **Location:** Data Extensions > JOURNEYS
- **Created by:** Keyona

## Automations

### Birthday_Daily_Send_Refresh
Daily at 5 AM CT. Runs the birthday SQL query.
- **Automation ID:** `11515afe-c5c3-4b6e-8005-f7e8c8a50a45`
- **Status:** Created, NOT activated

### Birthday_Daily_Filter (SQL Query)
- **Query ID:** `cbb76dd1-0bfd-4bbc-a05d-5b91e6984c43`
- **Target:** Birthday_Daily_Send (Overwrite)

## Journeys

### Birthday Daily Email
- **Journey ID:** `d53b5e04-ec9a-4526-b05e-8b8bd0b6e746`
- **Event Key:** `ContactEvent-d3c7ed48-1809-303f-c8cf-c3fc8b6844e4`
- **Status:** Published

### Birthday Quiz Follow-Up
- **Journey ID:** `cb195f60-a163-4a5b-b4cc-2ecb6a62c485`
- **Status:** Published

## Testing
- **Birthday_Test_Seed:** `birthday-test-seed-1776110854336`
- 7 test emails loaded
',
  permission = 'view-all'
WHERE workspace_id = 'a1b2c3d4-0000-0000-0000-000000000001'
  AND filename = 'environment.md';

-- Set David's active workspace to Birthday Campaign
UPDATE org_members
SET active_workspace_id = 'a1b2c3d4-0000-0000-0000-000000000001'
WHERE org_id = '58e43330-c76c-474c-b89e-7a2d606a4a61'
  AND user_id = 'dab61e85-4a99-4641-9b2d-957b12843f0a';
