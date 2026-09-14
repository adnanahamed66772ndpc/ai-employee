import { defineConfig } from "vitest/config";

// These tests run real git (clones, fetches, worktrees); alongside the other workspaces' suites a single test can take
// longer than vitest's 5 second default.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } });
