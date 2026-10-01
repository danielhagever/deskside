CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ws TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',          -- open | waiting | resolved | closed
  priority TEXT NOT NULL DEFAULT 'normal',      -- low | normal | high | urgent
  summary TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  watch_service TEXT,                            -- service key from status.ts, watched by the cron
  watch_since_status TEXT,
  followup_at TEXT,                              -- ISO time for a scheduled re-check
  history TEXT NOT NULL DEFAULT '[]',            -- JSON array of {at, text}
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_ws ON tickets(ws, status);

CREATE TABLE IF NOT EXISTS devices (
  ws TEXT NOT NULL,
  name TEXT NOT NULL,                            -- "office printer", "dad's laptop"
  kind TEXT NOT NULL,                            -- printer | router | laptop | desktop | phone | other
  model TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ws, name)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  ws TEXT NOT NULL,
  playbook TEXT NOT NULL,
  node TEXT NOT NULL,
  device TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',         -- active | fixed | escalated | abandoned
  trail TEXT NOT NULL DEFAULT '[]',              -- JSON array of {node, answer, at}
  ticket_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_ws ON sessions(ws, status);

CREATE TABLE IF NOT EXISTS services (
  ws TEXT NOT NULL,
  service TEXT NOT NULL,                         -- services this workspace relies on
  PRIMARY KEY (ws, service)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ws TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_ws ON events(ws, seen);
