-- Per-project auto-deploy toggle and the latest pushed head commit reported
-- by the GitHub webhook (used to show "undeployed commits" in the UI).
ALTER TABLE projects ADD COLUMN auto_deploy INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN head_sha TEXT;
ALTER TABLE projects ADD COLUMN head_message TEXT;
ALTER TABLE projects ADD COLUMN head_pushed_at TEXT;
