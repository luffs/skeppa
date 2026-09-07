-- Tenant projects route under their owner's handle (subdomain.handle.base),
-- so subdomain uniqueness is per owner namespace — which a single-table index
-- cannot express, since the handle lives on users. The route validation owns
-- the invariant now, exactly as it already does for ports. A plain index
-- stays for the lookups.
DROP INDEX idx_projects_subdomain;
CREATE INDEX idx_projects_subdomain ON projects(subdomain) WHERE subdomain IS NOT NULL;
