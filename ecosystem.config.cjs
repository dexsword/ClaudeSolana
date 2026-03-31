/**
 * PM2 ecosystem config.
 * Keeps app definition in-repo without embedding secrets.
 */

module.exports = {
  apps: [
    {
      // Keep name aligned with existing deployments.
      name: 'solana-bot-v1',
      script: 'dist/index.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
