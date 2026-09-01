-- Plain-git projects: a public https clone URL instead of a GitHub App repo.
-- '' plays the "unset" role (matching repo_full_name's NOT NULL and the
-- LiveState convention of '' for absent strings); exactly one of the two is
-- set, enforced in validation. No webhook exists for these — the head is
-- refreshed manually via git ls-remote.
ALTER TABLE projects ADD COLUMN git_url TEXT NOT NULL DEFAULT '';
