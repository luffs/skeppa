-- OCI image the deploy script runs in when the build sandbox is enabled
-- (SKEPPA_SANDBOX=podman). NULL = the panel-wide default (config.buildImage).
ALTER TABLE projects ADD COLUMN build_image TEXT;
