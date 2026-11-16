-- TEMPLATE — not applied or validated against a live environment.
-- Postgres 16 schema for durable state. No private keys are stored anywhere:
-- wallets carry only key_ref, an opaque handle resolved by the signer service.
--
-- RLS: tenant tables filter on user_id = current_setting('app.user_id', true)::uuid.
-- Application connections must run `SET LOCAL app.user_id = '<uuid>'` per
-- transaction. Table owner/superuser bypasses RLS unless FORCE is set (done
-- below); background workers should use a dedicated role with BYPASSRLS
-- granted deliberately, not the owner.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- Generic guard for append-only tables.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % not permitted', TG_TABLE_NAME, TG_OP;
END $$;

-- ---------------------------------------------------------------- users
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text UNIQUE NOT NULL,
  email       text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------- wallets
CREATE TABLE wallets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  chain       text NOT NULL,
  address     text NOT NULL,
  key_ref     text NOT NULL,                  -- opaque signer handle; NOT a key
  automation_enabled boolean NOT NULL DEFAULT false,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, address)
);
CREATE INDEX ON wallets (user_id);

-- ------------------------------------------------------ nonce_allocations
CREATE TABLE nonce_allocations (
  wallet_id   uuid NOT NULL REFERENCES wallets(id),
  chain       text NOT NULL,
  next_nonce  bigint NOT NULL CHECK (next_nonce >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_id, chain)
);

-- ----------------------------------------------------------- tx_records
CREATE TABLE tx_records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  wallet_id        uuid NOT NULL REFERENCES wallets(id),
  chain            text NOT NULL,
  idempotency_key  text NOT NULL UNIQUE,
  state            text NOT NULL DEFAULT 'intent'
    CHECK (state IN ('intent','nonce_allocated','signed','submitted','pending',
                     'confirmed','failed','replaced','dropped','reverted')),
  intent           jsonb NOT NULL,
  tx               jsonb,                     -- signed tx payload (reused on resubmit)
  receipt          jsonb,
  nonce            bigint,
  hash             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON tx_records (user_id);
CREATE INDEX ON tx_records (state) WHERE state IN ('signed','submitted','pending');
CREATE UNIQUE INDEX tx_records_wallet_nonce ON tx_records (wallet_id, chain, nonce)
  WHERE nonce IS NOT NULL AND state NOT IN ('replaced','dropped','failed');
CREATE INDEX ON tx_records (hash) WHERE hash IS NOT NULL;

-- --------------------------------------------------------------- orders
CREATE TABLE orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  wallet_id   uuid REFERENCES wallets(id),
  tx_record_id uuid REFERENCES tx_records(id),
  side        text NOT NULL CHECK (side IN ('buy','sell')),
  asset       text NOT NULL,
  amount      numeric(78,0) NOT NULL CHECK (amount > 0),
  status      text NOT NULL DEFAULT 'open',
  params      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON orders (user_id, status);

-- --------------------------------------------------------- reservations
CREATE TABLE reservations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  order_id    uuid REFERENCES orders(id),
  asset       text NOT NULL,
  amount      numeric(78,0) NOT NULL CHECK (amount > 0),
  status      text NOT NULL DEFAULT 'held' CHECK (status IN ('held','released','consumed')),
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON reservations (user_id, status);

-- -------------------------------------------------------- copy_inventory
CREATE TABLE copy_inventory (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  source_ref  text NOT NULL,
  asset       text NOT NULL,
  quantity    numeric(78,0) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_ref, asset)
);

-- -------------------------------------------------------- ledger_entries
-- Append-only. Corrections are NEW entries that reverse by key
-- (reverses_key -> original key); originals are never edited or deleted.
CREATE TABLE ledger_entries (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key           text NOT NULL UNIQUE,
  user_id       uuid NOT NULL REFERENCES users(id),
  account       text NOT NULL,
  asset         text NOT NULL,
  amount        numeric(78,0) NOT NULL,       -- signed
  reverses_key  text REFERENCES ledger_entries(key),
  tx_record_id  uuid REFERENCES tx_records(id),
  meta          jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ledger_entries (user_id, account, asset);
CREATE UNIQUE INDEX ledger_one_reversal ON ledger_entries (reverses_key) WHERE reverses_key IS NOT NULL;
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- --------------------------------------------------------------- claims
CREATE TABLE claims (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id    text NOT NULL UNIQUE,
  user_id     uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON claims (user_id);

-- --------------------------------------------------------------- outbox
CREATE TABLE outbox (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic         text NOT NULL,
  message_key   text,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX ON outbox (id) WHERE published_at IS NULL;

-- ---------------------------------------------------------------- inbox
CREATE TABLE inbox (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id   text NOT NULL UNIQUE,
  topic        text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

-- --------------------------------------------------------- signer_audit
CREATE TABLE signer_audit (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wallet_id   uuid,
  key_ref     text,
  action      text NOT NULL,                  -- sign, deny, revoke, rotate, ...
  request_id  text,
  detail      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER signer_audit_append_only
  BEFORE UPDATE OR DELETE ON signer_audit
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER signer_audit_no_truncate
  BEFORE TRUNCATE ON signer_audit
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- -------------------------------------------------------- subscriptions
CREATE TABLE subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  plan        text NOT NULL,
  status      text NOT NULL DEFAULT 'active',
  current_period_end timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON subscriptions (user_id);

-- ------------------------------------------------------------ referrals
CREATE TABLE referrals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),  -- referrer (tenant owner)
  referred_user_id uuid REFERENCES users(id),
  code             text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON referrals (user_id);

-- ------------------------------------------------------ row-level security
-- Tenant tables with a user_id column. `users` is keyed by id.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wallets','tx_records','orders','reservations',
    'copy_inventory','ledger_entries','claims','subscriptions','referrals']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (user_id = app_current_user()) WITH CHECK (user_id = app_current_user())', t);
  END LOOP;
END $$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users
  USING (id = app_current_user()) WITH CHECK (id = app_current_user());

-- nonce_allocations, outbox, inbox, signer_audit are service-level tables
-- (no user_id); restrict via GRANTs to service roles, not RLS.

COMMIT;
