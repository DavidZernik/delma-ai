-- Seed the Quality Lab's simulation user in auth.users.
--
-- The overnight narrative runner (server/quality/narratives.js) uses a
-- hardcoded UUID '00000000-0000-0000-0000-000000000001' as the "user"
-- that creates orgs + workspaces during sims. organizations.created_by
-- has an FK to auth.users(id), so without this row every narrative
-- insert fails with organizations_created_by_fkey and the run crashes
-- before a single op executes.
--
-- This is a fake service-account user. It should never log in or hold
-- real data. ON CONFLICT keeps re-runs safe.

INSERT INTO auth.users (id, email, role, aud, email_confirmed_at, created_at, updated_at)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'quality-lab-sim@delma.invalid',
  'authenticated',
  'authenticated',
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;
