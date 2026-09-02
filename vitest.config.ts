import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    // The Playwright specs in e2e/ have their own runner.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
    // Integration tests set up real git repos in a temp dir; those are slow on
    // Windows, so wider than the vitest default of 5s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      // The automatic pass starts a real agent with the test repo as its cwd. That
      // holds on to the directory and needs auth, so in tests it stays off (§9).
      REVIEWGATE_AUTO_REVIEW: "0",
      REVIEWGATE_NO_OPEN: "1",
    },
  },
});
