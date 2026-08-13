-- Whether the panel writes decrypted ENV vars to disk as shared/.env (plus a
-- copy in the working dir) for tools that read .env files themselves (e.g.
-- Vite at build time). Off by default for new projects — ENV is injected into
-- the deploy script and pm2 process environment instead, so decrypted values
-- only live in memory. Existing projects are backfilled to 1 so an upgrade
-- never silently removes a .env their build relies on.
ALTER TABLE projects ADD COLUMN write_env_file INTEGER NOT NULL DEFAULT 0;
UPDATE projects SET write_env_file = 1;
