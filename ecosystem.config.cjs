// pm2 process definition for support-app on the DEV droplet.
// Mirrors wf-server's own ecosystem.config.cjs pattern - see that file's
// header comments for why: node --env-file (not dotenv, ESM hoisting bit
// wf-server once), watch:false (a deploy target, not a dev box).
module.exports = {
  apps: [
    {
      name: 'support-app',
      script: 'server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      node_args: '--env-file=.env',
      autorestart: true,
      watch: false
    }
  ]
};
