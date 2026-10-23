-- Sync renewal confirmations (PRD F8.8, §7).
--
-- The bundle includes the first year of Sync, paid once. Around day 355 the customer gets an
-- email asking whether to continue at $24/year, and Sync renews **only if they confirm** —
-- nothing charges itself. This table is the one-time token in that email.
--
-- Why a token rather than just a link keyed on the licence: the link lands in an inbox, so it
-- has to be unguessable, single-use and expiring. Stored hashed like every other credential
-- here, so a database dump cannot be used to start checkouts on other people's accounts.
--
-- `claims` could not be reused: its `kind` column has a CHECK constraint of
-- ('purchase','device_limit'), and widening that is a bigger migration than adding this.

CREATE TABLE renewal_tokens (
  token_hash TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  -- The renewal this token is for, as a year key. Matches `emails_sent.period_key`, so a
  -- second year's notice is a separate row rather than a collision with the first.
  period_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX idx_renewal_tokens_license ON renewal_tokens(license_id);
CREATE INDEX idx_renewal_tokens_expires ON renewal_tokens(expires_at);
