-- Rotating an agent's key (routes/nodes.js /:id/rotate): the new key's hash
-- waits in `next_key_hash` while the agent is told, and both keys dial in
-- until the agent is heard using the new one — then it becomes `key_hash`
-- ('' = no rotation outstanding). A rotation the agent confirmed skips the
-- wait.
--
-- `agent_protocol` / `agent_min_protocol`: the fleet protocol range the
-- agent's hello said (nodes/protocol.js), kept like `agent_version` so an
-- offline node still shows it. 0 = never said.
ALTER TABLE nodes ADD COLUMN next_key_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE nodes ADD COLUMN agent_protocol INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN agent_min_protocol INTEGER NOT NULL DEFAULT 0;
