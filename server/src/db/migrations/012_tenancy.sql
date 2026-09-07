-- Multi-tenancy, phase 1: users get a role (existing users were all
-- full-access, so they become admins), a subdomain-safe handle (namespaces a
-- tenant's convoy networks now, their subdomains later) and a linked GitHub
-- login (matched against installation accounts so tenants see and moor only
-- their own repos). Projects get an owner; existing rows go to the first
-- user. A NULL owner (fresh install before seeding) is treated as
-- admin-owned by the code.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE users ADD COLUMN handle TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN github_login TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN owner_id INTEGER REFERENCES users(id);
UPDATE projects SET owner_id = (SELECT MIN(id) FROM users);
