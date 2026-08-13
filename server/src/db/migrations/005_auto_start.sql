-- Whether boot resurrection should start this app after a server reboot.
-- Managed by the panel's own actions: pm2 stop clears it, pm2 start/restart
-- and deploys set it. Distinct from pm2's autorestart (crash restarts) and
-- from auto_deploy (webhook deploys).
ALTER TABLE projects ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 1;
