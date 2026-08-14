-- Shipyard: panel-managed container images. The Containerfile in the DB is
-- the source of truth; the built image (localhost/skeppa/<name>:latest) is
-- disposable cache in the engine store, rebuilt on demand when missing.
CREATE TABLE images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  containerfile TEXT NOT NULL DEFAULT '',
  last_built_at TEXT,
  last_build_status TEXT, -- success|failed
  last_build_log TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
