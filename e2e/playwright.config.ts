import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

/*
  Playwright keeps its browsers in a cache outside the project (~/.cache/ms-playwright
  on Linux). A copy in .playwright/ keeps the whole run inside the project, which is
  what a sandboxed environment can reach. Fill it with:

      PLAYWRIGHT_BROWSERS_PATH=<repo>/.playwright npx playwright install chromium

  or copy an existing cache into it. Without that directory nothing changes and the
  usual cache is used.
*/
const local = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".playwright");
if (existsSync(local)) process.env["PLAYWRIGHT_BROWSERS_PATH"] ??= local;

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
