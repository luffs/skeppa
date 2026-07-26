-- Subdomain routing through the deployer-owned proxy: subdomain.<base_domain>
-- is reverse-proxied to localhost:<port>. Both nullable — a project without
-- them simply isn't routed.
ALTER TABLE projects ADD COLUMN subdomain TEXT;
ALTER TABLE projects ADD COLUMN port INTEGER;

CREATE UNIQUE INDEX idx_projects_subdomain ON projects(subdomain) WHERE subdomain IS NOT NULL;
