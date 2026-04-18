-- Switch sfmc_accounts encrypted columns from bytea (pgcrypto) to text
-- (Node-side AES-256-GCM). Supabase managed DBs don't allow ALTER DATABASE
-- SET app.crypto_key, so the pg-side helpers from 017 are unusable. We
-- now encrypt in Node before insert and decrypt before use; payloads carry
-- their own version + iv + auth tag (`v1:<iv>:<tag>:<ciphertext>`).

ALTER TABLE sfmc_accounts ALTER COLUMN client_id_enc      TYPE text USING NULL;
ALTER TABLE sfmc_accounts ALTER COLUMN client_secret_enc  TYPE text USING NULL;
ALTER TABLE sfmc_accounts ALTER COLUMN access_token_enc   TYPE text USING NULL;
ALTER TABLE sfmc_accounts ALTER COLUMN refresh_token_enc  TYPE text USING NULL;

-- The pg helpers aren't called anymore; drop them so they don't mislead.
DROP FUNCTION IF EXISTS enc_secret(text);
DROP FUNCTION IF EXISTS dec_secret(bytea);

-- Lock down: writes go through the server only.
ALTER TABLE sfmc_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sfmc_accounts_no_client_access ON sfmc_accounts;
CREATE POLICY sfmc_accounts_no_client_access ON sfmc_accounts
  FOR SELECT USING (false);
-- (No insert/update/delete policies → blocked for the authenticated role.
--  Service role bypasses RLS anyway, which is what the server uses.)
