-- Other Skeppa servers that report to this one ("agents"; the Fleet page).
-- An agent dials this panel at /agent with a long-lived key and serves its
-- live state through that socket; this panel only ever stores hashes:
-- `key_hash` of the agent's key ('' = not paired), `join_hash` of the
-- one-time code that pairs it ('' = none outstanding) with its expiry as an
-- ISO instant. `last_seen_at` and `agent_version` are what the agent last
-- said ('' = never connected).
CREATE TABLE nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  key_hash TEXT NOT NULL DEFAULT '',
  join_hash TEXT NOT NULL DEFAULT '',
  join_expires_at TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT NOT NULL DEFAULT '',
  agent_version TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
