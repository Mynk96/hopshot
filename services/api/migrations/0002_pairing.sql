-- Pairing lockout and live tickets (ARCHITECTURE §7.2, §7.4).
--
-- Both of these are state that §7.2/§7.4 require but `0001_init.sql` has nowhere to put:
--
-- * `invites.failed_attempts` counts failures against *one invite code*. The limit in §7.2
--   is "at most 5 failed attempts per IP per 10 min", and a brute-forcer tries a different
--   code every time — so a per-invite counter never trips. The limit has to be keyed by IP.
--
-- * `usage` is keyed by calendar day (`YYYY-MM-DD`), so it cannot express a rolling
--   10-minute window, and the pairing limit is deliberately short-lived rather than daily.
--
-- * A live ticket is "valid 60 s, single use". The single-use half needs somewhere to record
--   that it has been spent; a signed, stateless ticket could not be burned.

-- One row per (IP, 10-minute bucket). Pruned by the 15-minute cron.
CREATE TABLE pair_attempts (
  ip_hash TEXT NOT NULL,
  -- Bucket start in ms, floor(now / 600000) * 600000.
  window_start INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, window_start)
);
CREATE INDEX idx_pair_attempts_window ON pair_attempts(window_start);

-- WebSocket upgrade tickets. Browsers cannot set an Authorization header on a WebSocket
-- (§7.4), so the device token is exchanged for one of these first.
CREATE TABLE live_tickets (
  ticket_hash TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_live_tickets_expires ON live_tickets(expires_at);
