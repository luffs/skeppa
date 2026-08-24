-- Network profiles for container-runtime projects. `open` keeps the engine
-- default (internet + LAN, as before); `restricted` joins the project only to
-- its named internal networks — no internet, no LAN, no host. `networks` is a
-- space-separated list of convoy network names (always created Internal);
-- `host_access` opts an open project into reaching the host's loopback
-- services (rootless podman denies that by default).
ALTER TABLE projects ADD COLUMN network_profile TEXT NOT NULL DEFAULT 'open';
ALTER TABLE projects ADD COLUMN host_access INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN networks TEXT NOT NULL DEFAULT '';
