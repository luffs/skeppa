// pm2 config for the panel itself. Start with: pm2 start ecosystem.config.cjs
//
// The interpreter is baked in as an absolute path: bun's own installer puts
// it in ~/.bun/bin, a package manager in /usr/bin or /usr/local/bin, and
// the pm2 daemon's boot PATH often has neither. Self-deploys reload through
// this file as it is in the deployed checkout, so a hand edit there does not
// last. If bun lives somewhere this does not look, set BUN_PATH: in the
// shell for a first `pm2 start`, in the panel project's Manifest for
// self-deploys (its ENV is the pm2 CLI's environment there).
const { existsSync } = require('node:fs')
const { delimiter, join } = require('node:path')

function findBun() {
  const home = process.env.HOME
  const candidates = [
    process.env.BUN_PATH,
    process.env.BUN_INSTALL && join(process.env.BUN_INSTALL, 'bin', 'bun'),
    home && join(home, '.bun', 'bin', 'bun'),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, 'bun')),
    '/usr/local/bin/bun',
    '/usr/bin/bun',
  ]
  return candidates.find(path => path && existsSync(path)) ?? 'bun'
}

module.exports = {
  apps: [
    {
      name: 'skeppa',
      script: 'server/src/index.js',
      interpreter: findBun(),
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        SKEPPA_PM2_NAME: 'skeppa',
      },
      autorestart: true,
      max_restarts: 10,
    },
  ],
}
