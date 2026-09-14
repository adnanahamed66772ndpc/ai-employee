// Production mode: one process serving the built dashboard and the API.
//   npm run build && pm2 start deploy/pm2/prod.config.cjs      (nginx upstream port 7717)
const { root } = require("./env.cjs");

module.exports = {
  apps: [
    {
      name: "ai-employee",
      cwd: root,
      script: "npm",
      args: "start",
      env: { NODE_ENV: "production" },
      // Give the server time to stop DeepSeek Harness processes cleanly.
      kill_timeout: 15000,
      max_restarts: 20,
    },
  ],
};
