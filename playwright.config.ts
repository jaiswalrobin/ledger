import { defineConfig } from "@playwright/test";
import chromium from "@sparticuz/chromium";

export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  fullyParallel: false,
  timeout: 45000,
  use: {
    baseURL: process.env.BROWSER_BASE_URL ?? "http://127.0.0.1:3000",
    headless: true,
    // The packaged Chromium is a Linux binary, which is what CI runs. Anywhere else (for example a
    // Mac running `npm run check:full`) use the Google Chrome installed on the machine.
    launchOptions:
      process.platform === "linux"
        ? {
            executablePath: await chromium.executablePath(),
            // Packaged serverless defaults disable browser security and crash when the
            // runner closes one context in single-process mode. Use normal isolation.
            args: chromium.args.filter(
              (arg) =>
                ![
                  "--single-process",
                  "--disable-web-security",
                  "--allow-running-insecure-content",
                  "--disable-site-isolation-trials",
                  "--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process",
                ].includes(arg),
            ),
            env: {
              ...process.env,
              XDG_CACHE_HOME: "/tmp/ledger-browser-cache",
            },
          }
        : { channel: "chrome" },
    viewport: { width: 1440, height: 1000 },
  },
  reporter: "list",
  outputDir: "/tmp/ledger-browser-results",
});
