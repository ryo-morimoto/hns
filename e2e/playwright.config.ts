import { defineConfig } from "@playwright/test";

/**
 * The office journey's runner.
 *
 * @remarks
 * **One project (Chromium) and one worker.** The journey opens the app's compiled documents and the
 * real preview route against one edge and one machine; a second worker would race the pack's
 * cache and the machine's single office execution slot (one job at a time, `engine_busy`), so
 * the journey is serial by construction.
 *
 * The browsers come from this package's own `npm install` and `npx playwright install chromium`
 * (`npm run browsers`), and `PLAYWRIGHT_BROWSERS_PATH` names where they were installed when the
 * host keeps them out of the default location.
 */
export default defineConfig({
  testDir: "./journeys",
  // A document's first preview is a real conversion: three formats, two opens each, and a
  // two-minute machine budget for the slowest.
  timeout: 180_000,
  expect: { timeout: 60_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: ".cache/report" }]],
  outputDir: ".cache/results",
  use: {
    browserName: "chromium",
    viewport: { width: 1280, height: 720 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});