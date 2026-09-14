const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..", "..");

/** Reads KEY=value lines from .env.local (the server loads the file itself; Vite needs a few values). */
function readEnvLocal() {
  try {
    const entries = readFileSync(join(root, ".env.local"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]);
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

module.exports = { root, readEnvLocal };
