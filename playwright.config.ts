import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./dev-harness/tests",
  fullyParallel: true,
  // Most of a test is the harness's simulated round-trips, which overlap well.
  // Past about half the cores, the dev server and the motion tests' timing
  // start to suffer.
  workers: "50%",
  use: {
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 1500, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    reducedMotion: "reduce",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1500, height: 1000 } },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], viewport: { width: 1500, height: 1000 } },
    },
  ],
  webServer: {
    command: "pnpm dev --host 127.0.0.1",
    url: "http://127.0.0.1:1420/dev-harness/",
    reuseExistingServer: !process.env.CI,
  },
});
