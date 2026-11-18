-- Project groups ("piers" in the UI): pure organization — a pier changes
-- where a project is listed, never what it runs, reaches or is routed as.
-- A pier belongs to one owner and holds only that owner's projects, so it
-- travels in the owner's fleet store like the projects do. Names are unique
-- per owner, case-insensitively. Removing a pier leaves its projects
-- ungrouped; removing a user takes their (by then empty) piers along.
CREATE TABLE project_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, name COLLATE NOCASE)
);
ALTER TABLE projects ADD COLUMN group_id INTEGER REFERENCES project_groups(id) ON DELETE SET NULL;
CREATE INDEX idx_projects_group ON projects(group_id) WHERE group_id IS NOT NULL;
