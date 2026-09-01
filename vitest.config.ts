import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    // Integratietests zetten echte git-repo's op in een tempdir; die zijn traag
    // op Windows, dus ruimer dan de vitest-default van 5s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
