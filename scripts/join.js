// Pairs this server with a master panel, so it reports there (agent mode).
//
//   bun scripts/join.js <master url> <code>
//
// The code comes from the master's Fleet page (+ Add a server, or New code),
// is good once, for ten minutes. This spends it for a long-lived key, writes
// the key chmod 600 next to the config file (AGENT_KEY_FILE overrides where),
// and sets MASTER_URL in the config file. Restart the panel afterwards.
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configFilePath, parseMasterUrl } from '../server/src/config.js'
import { parseJoinCode } from '../server/src/nodes/keys.js'

const [rawUrl, code] = process.argv.slice(2)
if (!rawUrl || !code) {
  console.error('usage: bun scripts/join.js <master url> <code>')
  process.exit(2)
}
const masterUrl = parseMasterUrl(rawUrl)
if (!masterUrl) {
  console.error(`not an http(s) URL of a panel: ${rawUrl}`)
  process.exit(2)
}
if (!parseJoinCode(code)) {
  console.error('that is not a join code — copy it from the master\'s Fleet page (skj_…)')
  process.exit(2)
}
if (masterUrl.startsWith('http:')) console.warn('warning: plain http — the key will travel unencrypted. Use https unless this is a trusted LAN.')

let res
try {
  res = await fetch(`${masterUrl}/api/nodes/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
} catch (err) {
  console.error(`could not reach ${masterUrl}: ${err.message}`)
  process.exit(1)
}
const body = await res.json().catch(() => ({}))
if (!res.ok || typeof body.key !== 'string') {
  console.error(`the master said no (${res.status}): ${body.error ?? 'no reason given'}`)
  process.exit(1)
}

const configPath = configFilePath()
const keyFile = process.env.AGENT_KEY_FILE || join(dirname(configPath), 'agent.key')
mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 })
writeFileSync(keyFile, `${body.key}\n`, { mode: 0o600 })
chmodSync(keyFile, 0o600) // an existing file keeps its mode on write

// MASTER_URL in the config file: replaced where it is, appended otherwise.
const lines = existsSync(configPath) ? readFileSync(configPath, 'utf8').split('\n') : []
const at = lines.findIndex(line => /^\s*MASTER_URL\s*=/.test(line))
if (at >= 0) lines[at] = `MASTER_URL=${masterUrl}`
else {
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  lines.push(`MASTER_URL=${masterUrl}`, '')
}
mkdirSync(dirname(configPath), { recursive: true })
writeFileSync(configPath, lines.join('\n'))

console.log(`paired as "${body.node.name}" (node ${body.node.id}) with ${masterUrl}`)
console.log(`  key:    ${keyFile}`)
console.log(`  config: ${configPath} (MASTER_URL)`)
if (process.env.MASTER_URL && parseMasterUrl(process.env.MASTER_URL) !== masterUrl) {
  console.warn(`note: MASTER_URL is also set in this process's environment (${process.env.MASTER_URL}) and wins over the file`)
}
console.log('restart the panel to connect, e.g.  pm2 reload skeppa')
console.log('from then on this server is run from the master: its own panel is off (AGENT_LOCAL_UI=true in the config turns it back on)')
