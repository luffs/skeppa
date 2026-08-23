-- Optional per-container memory cap in megabytes; NULL = unlimited.
-- Container runtime only: pm2 apps are host processes the panel does not cap.
ALTER TABLE projects ADD COLUMN memory_mb INTEGER;
