import { defineConfig } from "@playwright/test";

// The codemap bench: Chromium on the real GPU as the app's CEF window draws, at Retina scale.
export default defineConfig({
  testDir: ".",
  testMatch: "*.bench.ts",
  workers: 1,
  timeout: 15 * 60_000,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:1420",
    browserName: "chromium",
    viewport: { width: 1500, height: 1000 },
    deviceScaleFactor: 2,
    launchOptions: { args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal"] },
  },
  webServer: {
    command: "pnpm dev --host 127.0.0.1",
    url: "http://127.0.0.1:1420/dev-harness/",
    reuseExistingServer: true,
  },
});
