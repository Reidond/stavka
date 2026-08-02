import agents from "agents/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [agents()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
