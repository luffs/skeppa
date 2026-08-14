-- Where the app process runs: 'pm2' (host process, the default) or
-- 'container' (rootless podman: source mounted read-only at /app, shared/
-- writable at /data, the routed port published on localhost). Takes effect on
-- the next deploy. run_image is the container image for the app; NULL falls
-- back to build_image, then the panel-wide default.
ALTER TABLE projects ADD COLUMN runtime TEXT NOT NULL DEFAULT 'pm2';
ALTER TABLE projects ADD COLUMN run_image TEXT;
