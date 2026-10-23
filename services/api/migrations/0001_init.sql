-- Hopshot D1 schema (ARCHITECTURE §7.7).
--
-- Transcribed from the architecture document; keep the two in step. Phase 3.2 uses `drops`,
-- `usage` and `reports`; the rest are created now so later phases are a code change rather
-- than a migration against live data.

CREATE TABLE drops (
  id TEXT PRIMARY KEY, r2_key TEXT NOT NULL, size INTEGER NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, deleted_at INTEGER,
  delete_token_hash TEXT NOT NULL, view_count INTEGER NOT NULL DEFAULT 0,
  install_id TEXT, ip_hash TEXT, plan TEXT NOT NULL
);
CREATE INDEX idx_drops_expires ON drops(expires_at);

CREATE TABLE vaults (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at INTEGER NOT NULL   -- owner = license id, or 'trial:{installId}'
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('desktop','phone')),
  token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
  last_seen_at INTEGER, revoked_at INTEGER
);
CREATE TABLE invites (
  code_hash TEXT PRIMARY KEY, vault_id TEXT NOT NULL, created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL, used_at INTEGER, failed_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE items (
  id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  source_device_id TEXT NOT NULL, r2_key TEXT NOT NULL, size INTEGER NOT NULL,
  meta TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX idx_items_vault_created ON items(vault_id, created_at DESC);
CREATE INDEX idx_items_expires ON items(expires_at);

CREATE TABLE customers (
  stripe_customer_id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT,
  created_at INTEGER NOT NULL, reminders_off_at INTEGER
);
CREATE INDEX idx_customers_email ON customers(email);
CREATE TABLE licenses (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(stripe_customer_id),
  plan TEXT NOT NULL CHECK (plan IN ('lifetime','bundle')),
  source TEXT NOT NULL CHECK (source IN ('checkout','founder','comp')),
  checkout_session_id TEXT UNIQUE, payment_intent_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','refunded','revoked')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_licenses_customer ON licenses(customer_id);
CREATE INDEX idx_licenses_pi ON licenses(payment_intent_id);
CREATE TABLE license_devices (
  id TEXT PRIMARY KEY, license_id TEXT NOT NULL REFERENCES licenses(id), install_id TEXT NOT NULL,
  label TEXT, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, removed_at INTEGER
);
CREATE INDEX idx_license_devices_license ON license_devices(license_id);
CREATE TABLE claims (                -- in-app purchases and pending 4th-computer choices
  id_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('purchase','device_limit')),
  install_id TEXT NOT NULL, label TEXT, plan TEXT, checkout_session_id TEXT, license_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending', delivered_at INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE restore_codes (
  email TEXT NOT NULL, install_id TEXT NOT NULL, code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, PRIMARY KEY (email, install_id)
);
CREATE TABLE subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL,
  status TEXT NOT NULL,                 -- trialing | active | past_due | paused | canceled | ...
  trial_end INTEGER, current_period_end INTEGER, past_due_since INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0, has_payment_method INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_subscriptions_customer ON subscriptions(customer_id);
CREATE TABLE trials (
  install_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ip_hash TEXT
);
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at INTEGER NOT NULL
);
CREATE TABLE emails_sent (           -- period_key = the renewal date, so yearly notices repeat each year
  subject_id TEXT NOT NULL, kind TEXT NOT NULL, period_key TEXT NOT NULL DEFAULT '',
  sent_at INTEGER NOT NULL, PRIMARY KEY (subject_id, kind, period_key)
);
CREATE TABLE usage (
  day TEXT NOT NULL, subject TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, subject, kind)
);
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, drop_id TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL
);
