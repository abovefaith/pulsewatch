/**
 * Ordered, append-only schema migrations. The array index + 1 is the schema
 * version, tracked in SQLite's built-in `PRAGMA user_version`.
 * Never edit a migration that has shipped — add a new one instead.
 */
export const migrations: readonly string[] = [
  /* sql */ `
  CREATE TABLE monitors (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    url               TEXT NOT NULL,
    method            TEXT NOT NULL CHECK (method IN ('GET', 'HEAD', 'POST')),
    interval_seconds  INTEGER NOT NULL CHECK (interval_seconds > 0),
    timeout_ms        INTEGER NOT NULL CHECK (timeout_ms > 0),
    expected_status   INTEGER,
    failure_threshold INTEGER NOT NULL DEFAULT 3,
    webhook_url       TEXT,
    paused            INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE checks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id  TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    checked_at  INTEGER NOT NULL,
    ok          INTEGER NOT NULL,
    status_code INTEGER,
    latency_ms  REAL,
    error       TEXT
  ) STRICT;

  CREATE INDEX idx_checks_monitor_id ON checks (monitor_id, id DESC);
  CREATE INDEX idx_checks_checked_at ON checks (checked_at);

  CREATE TABLE incidents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id  TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    started_at  INTEGER NOT NULL,
    resolved_at INTEGER,
    cause       TEXT NOT NULL
  ) STRICT;

  -- The database itself guarantees at most one open incident per monitor.
  CREATE UNIQUE INDEX idx_incidents_one_open ON incidents (monitor_id) WHERE resolved_at IS NULL;
  CREATE INDEX idx_incidents_monitor ON incidents (monitor_id, started_at DESC);
  `,
];
