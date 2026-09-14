// Development mode: API server with file watching + Vite dev server with hot reload.
//   pm2 start deploy/pm2/dev.config.cjs      (nginx upstream port 5173)
const { root, readEnvLocal } = require("./env.cjs");

const env = readEnvLocal();

module.exports = {
  apps: [
    {
      name: "ai-employee-dev-server",
      cwd: root,
      script: "npm",
      args: "run dev",
      env: { NODE_ENV: "development" },
      kill_timeout: 15000,
    },
    {
      name: "ai-employee-dev-dashboard",
      cwd: root,
      script: "npm",
      args: "run dev:dashboard",
      env: {
        NODE_ENV: "development",
        AI_EMPLOYEE_PUBLIC_URL: env.AI_EMPLOYEE_PUBLIC_URL || "",
        AI_EMPLOYEE_PORT: env.AI_EMPLOYEE_PORT || "",
      },
    },
  ],
};
