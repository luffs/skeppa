-- An app (container or pm2) whose build output the harbor gate serves itself:
-- after the deploy script, `publish_dir` is copied into the same panel-owned
-- snapshot a static site uses, and a GET for a file that is in it is answered
-- by the gate (index.html, /assets/…); every other request goes to the app's
-- port as before. Off by default — the app's own access rules do not apply to
-- files the gate serves.
ALTER TABLE projects ADD COLUMN gate_files INTEGER NOT NULL DEFAULT 0;
