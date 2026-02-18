CREATE TABLE IF NOT EXISTS blocks (
  id BIGSERIAL PRIMARY KEY,
  height BIGINT NOT NULL,
  state_hash TEXT NOT NULL UNIQUE,
  parent_hash TEXT,
  ledger_hash TEXT,
  timestamp_ms BIGINT,
  global_slot BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id BIGSERIAL PRIMARY KEY,
  tx_hash TEXT NOT NULL UNIQUE,
  tx_kind TEXT,
  status TEXT,
  memo TEXT,
  sequence_no BIGINT,
  block_height BIGINT,
  public_key TEXT,
  token_id TEXT,
  payload_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_public_key ON transactions (public_key);
CREATE INDEX IF NOT EXISTS idx_transactions_block_height ON transactions (block_height DESC);

CREATE TABLE IF NOT EXISTS account_events (
  id BIGSERIAL PRIMARY KEY,
  tx_hash TEXT,
  payload_hash TEXT NOT NULL,
  public_key TEXT NOT NULL,
  token_id TEXT,
  block_height BIGINT,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_events_public_key ON account_events (public_key);
CREATE UNIQUE INDEX IF NOT EXISTS ux_account_events_payload_hash ON account_events (payload_hash);

CREATE TABLE IF NOT EXISTS account_actions (
  id BIGSERIAL PRIMARY KEY,
  tx_hash TEXT,
  payload_hash TEXT NOT NULL,
  public_key TEXT NOT NULL,
  token_id TEXT,
  block_height BIGINT,
  action_state_before TEXT,
  action_state_after TEXT,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_actions_public_key ON account_actions (public_key);
CREATE UNIQUE INDEX IF NOT EXISTS ux_account_actions_payload_hash ON account_actions (payload_hash);

CREATE TABLE IF NOT EXISTS tracked_accounts (
  id BIGSERIAL PRIMARY KEY,
  public_key TEXT NOT NULL,
  token_id TEXT,
  sequencer_url TEXT NOT NULL,
  backfill BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  initialized BOOLEAN NOT NULL DEFAULT FALSE,
  cursor_height BIGINT,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(public_key, token_id)
);

CREATE INDEX IF NOT EXISTS idx_tracked_accounts_enabled ON tracked_accounts (enabled);

CREATE TABLE IF NOT EXISTS sync_cursor (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  source TEXT NOT NULL,
  last_height BIGINT,
  last_state_hash TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
