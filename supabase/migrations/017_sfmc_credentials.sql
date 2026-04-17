-- SFMC credentials per org. Encrypted at rest using pgcrypto. No secrets in
-- plain columns. The encryption key lives as a Supabase secret (not on
-- disk, not in code) and is set via `ALTER DATABASE ... SET app.crypto_key`.
--
-- Each org can connect multiple SFMC accounts (parent BU + clients), but
-- v1 enforces one. Sandbox vs production distinguished by the auth URL.
--
-- Tokens refresh ~20 min before expiry via a scheduled function; the last
-- refresh result is written back so expired-token errors surface cleanly.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS sfmc_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connected_by    uuid,                              -- user who OAuthed
  account_label   text,                              -- "Emory Production" etc.
  auth_base_url   text NOT NULL,                     -- mcXXX.auth.marketingcloudapis.com
  rest_base_url   text NOT NULL,                     -- mcXXX.rest.marketingcloudapis.com
  soap_base_url   text NOT NULL,                     -- mcXXX.soap.marketingcloudapis.com
  is_sandbox      boolean NOT NULL DEFAULT false,
  client_id_enc   bytea NOT NULL,                    -- encrypted
  client_secret_enc bytea NOT NULL,                  -- encrypted
  account_id      text,                              -- MID (Marketing Cloud ID)
  scopes          text[],
  access_token_enc   bytea,
  refresh_token_enc  bytea,
  access_expires_at  timestamptz,
  last_refresh_at    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sfmc_accounts_org ON sfmc_accounts(org_id);

-- Helper functions: encrypt/decrypt secrets using the app crypto key.
-- Callers never touch raw pgcrypto — they use these wrappers.

CREATE OR REPLACE FUNCTION enc_secret(plain text) RETURNS bytea
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE k text;
BEGIN
  k := current_setting('app.crypto_key', true);
  IF k IS NULL OR k = '' THEN
    RAISE EXCEPTION 'app.crypto_key not set. Configure via ALTER DATABASE ... SET app.crypto_key.';
  END IF;
  RETURN pgp_sym_encrypt(plain, k);
END; $$;

CREATE OR REPLACE FUNCTION dec_secret(cipher bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE k text;
BEGIN
  IF cipher IS NULL THEN RETURN NULL; END IF;
  k := current_setting('app.crypto_key', true);
  IF k IS NULL OR k = '' THEN
    RAISE EXCEPTION 'app.crypto_key not set.';
  END IF;
  RETURN pgp_sym_decrypt(cipher, k);
END; $$;

-- Audit log for every SFMC operation the chat invokes. What changed, by whom,
-- when, with what args + result. Useful for compliance and for the quality
-- lab to verify tool calls hit SFMC as expected.
CREATE TABLE IF NOT EXISTS sfmc_audit_log (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id    uuid REFERENCES sfmc_accounts(id) ON DELETE SET NULL,
  user_id       uuid,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  tool_name     text NOT NULL,                       -- "create_journey", etc.
  args          jsonb,
  result        jsonb,
  status        text NOT NULL,                       -- 'ok' | 'error'
  error_message text,
  duration_ms   int,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sfmc_audit_org ON sfmc_audit_log(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sfmc_audit_tool ON sfmc_audit_log(tool_name, created_at DESC);
