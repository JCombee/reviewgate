import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // Every test sets up its own repo and server; running them in parallel only buys
  // port and process trouble.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  reporter: [["list"]],
});
