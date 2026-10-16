-- One row per child. `code` is the share code families type in; it is the only key to the data.
CREATE TABLE IF NOT EXISTS children (
  code TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
-- One row per (iPhone, child) that wants notifications.
CREATE TABLE IF NOT EXISTS devices (
  endpoint TEXT NOT NULL,
  code TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (endpoint, code)
);
CREATE INDEX IF NOT EXISTS devices_code ON devices(code);
-- Server settings: generated push keys, last processed minute.
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
