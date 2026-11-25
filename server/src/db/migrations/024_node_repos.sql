-- The GitHub repositories a fleet server may have read tokens for (nodes/
-- answers.js githubToken), decided here and never by what the server itself
-- reports: those an admin moored or pointed a project at there through the
-- relay (`how` = 'moored'), allowed by hand under its Pairing ('allowed'), or
-- what it reported the first time it was in step after pairing — or after
-- this table was added — taken as its own once ('reported'). `repos_seeded`
-- says that first look has happened (a new join code starts it over).
CREATE TABLE node_repos (
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  repo TEXT NOT NULL COLLATE NOCASE,
  how TEXT NOT NULL DEFAULT 'allowed',
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (node_id, repo)
);
ALTER TABLE nodes ADD COLUMN repos_seeded INTEGER NOT NULL DEFAULT 0;
