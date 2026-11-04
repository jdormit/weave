import { defineConfig } from "@playwright/test"

const PORT = Number(process.env.E2E_PORT ?? 4173)

/**
 * End-to-end tests run against a production build, with fake camera, screen
 * and microphone devices, and a real Whisper Tiny model on WASM.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: `bun run build && PORT=${PORT} bun run scripts/serve.ts`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
})
