import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // The workspace packages point at their tsc output, which a fresh checkout does
    // not have yet. Tests read the source instead, so `npm test` works before
    // `npm run build` and never runs against a stale dist.
    alias: {
      "@reviewgate/core/api": fileURLToPath(new URL("./packages/core/src/api.ts", import.meta.url)),
      "@reviewgate/core": src("core"),
      "@reviewgate/server": src("server"),
    },
  },
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
