// pm2 config for the panel itself. Adjust the interpreter path if bun lives
// elsewhere (which bun). Start with: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'skeppa',
      script: 'server/src/index.js',
      interpreter: process.env.HOME ? `${process.env.HOME}/.bun/bin/bun` : 'bun',
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
