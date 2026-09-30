-- Static runtime: a project whose deploy builds files the harbor gate serves
-- itself — no process, no container, no port. `publish_dir` is what the build
-- produces, relative to the working directory ('' = the directory itself);
-- `spa_fallback` answers unknown paths with index.html for client-side routers.
ALTER TABLE projects ADD COLUMN publish_dir TEXT NOT NULL DEFAULT 'dist';
ALTER TABLE projects ADD COLUMN spa_fallback INTEGER NOT NULL DEFAULT 0;
