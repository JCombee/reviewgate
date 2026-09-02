import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // Elke test zet zijn eigen repo en server op; parallel draaien levert alleen
  // poort- en procesgedoe op.
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
