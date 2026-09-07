-- Whether the project's decrypted ENV is injected into the deploy script
-- (build time). On keeps today's behavior — builds that generate clients or
-- read VITE_* config need it. Off gives the build only the minimal base env
-- and no .env in the working tree, so a poisoned dependency's postinstall
-- has nothing to exfiltrate; new tenant projects default to off.
ALTER TABLE projects ADD COLUMN build_env INTEGER NOT NULL DEFAULT 1;
