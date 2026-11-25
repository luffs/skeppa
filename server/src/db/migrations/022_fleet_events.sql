-- What was done to the Fleet's servers from this panel (nodes/events.js):
-- every change relayed to an agent, and each node's own life — created,
-- paired, renamed, unpaired, removed, away and back. `node_name` and
-- `subject` (the project, pier or image a change was about) are kept as they
-- read then, so the log still says something once the node or the project is
-- gone; `node_id` is not a foreign key for the same reason. `status` is the
-- HTTP status the agent answered (0 for none), `error` why it failed ('' when
-- it did not). Pruned to the newest few thousand.
CREATE TABLE fleet_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL,
  node_name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_fleet_events_node ON fleet_events(node_id, id);
