import { defineConfig } from "vitest/config";

// Several server tests drive real git repositories through many agent steps; on a busy machine even small tests can
// exceed vitest's 5 second default while those run alongside them.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } });
