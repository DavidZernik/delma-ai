-- Allow multiple SFMC connections per org, one per BU role.
-- A typical Marketing Cloud setup has one Installed Package in the Parent
-- BU (for enterprise data, account API) and a separate Installed Package
-- in the Child BU (for sends, journeys). Both share a subdomain but have
-- different Client IDs / Secrets / MIDs.

ALTER TABLE sfmc_accounts
  ADD COLUMN IF NOT EXISTS bu_role text NOT NULL DEFAULT 'child'
    CHECK (bu_role IN ('parent', 'child'));

-- One row per (org, role). Re-saving updates in place.
DROP INDEX IF EXISTS sfmc_accounts_org_role_uniq;
CREATE UNIQUE INDEX sfmc_accounts_org_role_uniq
  ON sfmc_accounts (org_id, bu_role);
