-- A tenant may route under a domain of their own instead of a label under
-- the panel's base domain (subdomain.handle.base): subdomain.<domain>, or the
-- domain itself for the project whose subdomain is '@'. Empty = no domain.
ALTER TABLE users ADD COLUMN domain TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX idx_users_domain ON users(domain) WHERE domain != '';
