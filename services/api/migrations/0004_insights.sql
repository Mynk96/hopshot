-- Usage counts, the mailing list and in-app feedback (ARCHITECTURE §7.10, 0.1.8).
--
-- Privacy (CLAUDE.md rule 1): nothing here holds an image, a file name, a key or an IP.
-- `installs` is keyed on the random, local install id the app already sends for its daily
-- send quota; it identifies an installation, not a person. `subscribers` is deliberately
-- unlinked from it, so an email address is never joined to anyone's usage.

-- One row per installation that has ever pinged.
CREATE TABLE installs (
  install_id TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,   -- server time of the first ping, ms
  last_seen INTEGER NOT NULL,    -- server time of the latest ping, ms
  version TEXT NOT NULL,         -- app version at the latest ping
  os TEXT NOT NULL CHECK (os IN ('macos', 'windows'))
);

-- Screenshots per installation per UTC day. A ping carries the running totals of recent
-- days and the server keeps the maximum, so a repeated or out-of-order ping never inflates
-- a count.
CREATE TABLE install_days (
  install_id TEXT NOT NULL,
  day TEXT NOT NULL,             -- YYYY-MM-DD, UTC
  captures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (install_id, day)
);
CREATE INDEX idx_install_days_day ON install_days(day);

-- The mailing list. Double opt-in: a row is `pending` until the emailed link is followed.
-- One token serves the confirm and unsubscribe links; only its hash is stored.
CREATE TABLE subscribers (
  email TEXT PRIMARY KEY,        -- lower-cased
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  source TEXT NOT NULL CHECK (source IN ('onboarding', 'website')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  unsubscribed_at INTEGER
);

-- "Is Hopshot useful to you?" — asked once, in the app, after about a week.
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  install_id TEXT,
  useful INTEGER NOT NULL CHECK (useful IN (0, 1)),
  comment TEXT,
  version TEXT,
  created_at INTEGER NOT NULL
);
