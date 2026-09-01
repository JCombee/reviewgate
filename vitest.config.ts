import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    // Integratietests zetten echte git-repo's op in een tempdir; die zijn traag
    // op Windows, dus ruimer dan de vitest-default van 5s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      // De automatische pass start een echte agent met de testrepo als cwd. Die
      // houdt de map vast en heeft auth nodig; in tests hoort hij dus uit (§9).
      REVIEWGATE_AUTO_REVIEW: "0",
      REVIEWGATE_NO_OPEN: "1",
    },
  },
});
