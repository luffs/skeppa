-- Host directories bind-mounted into a container app, a network share mounted
-- on the host for example: one per line, `host:target`, `:ro` for read-only
-- (lib/mounts.js). Set by admins only, and only under the config's
-- MOUNT_ROOTS; '' = none. Takes effect on the next deploy or restart.
ALTER TABLE projects ADD COLUMN mounts TEXT NOT NULL DEFAULT '';
