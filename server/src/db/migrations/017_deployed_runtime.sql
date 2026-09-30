-- What a project is actually being served as — the runtime of its last
-- successful deploy ('' = never deployed). `runtime` is what the form says and
-- what the NEXT deploy will do; this is what is live now. The harbor gate
-- routes by it, so switching an app to a static site (or back) flips the route
-- when the deploy has the new thing ready, not when the form is saved. It is
-- also how the runner knows a pm2 process is really being left behind, rather
-- than deleting whatever process happens to carry the project's pm2 name.
ALTER TABLE projects ADD COLUMN deployed_runtime TEXT NOT NULL DEFAULT '';
UPDATE projects SET deployed_runtime = runtime
 WHERE id IN (SELECT project_id FROM deployments WHERE status = 'success');
