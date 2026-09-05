import { defineConfig } from "@playwright/test";

const port = Number(process.env.STAVKA_QA_PORT ?? 18787);
export default defineConfig({
  testDir: "./tools/qa",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "node --import tsx tools/tasks/src/qa-server.ts",
      url: `http://127.0.0.1:${port}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
    ...["@stavka/inference", "@stavka/maskirovka-seat", "@stavka/maskirovka"].map(
      (name, index) => ({
        command: `pnpm --filter ${name} exec vp preview --config vite.dashboard.config.ts --host 127.0.0.1 --port ${port + index + 1} --strictPort`,
        url: `http://127.0.0.1:${port + index + 1}/_/`,
        reuseExistingServer: false,
        timeout: 30_000,
      }),
    ),
  ],
});
