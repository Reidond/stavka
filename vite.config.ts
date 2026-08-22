import agents from "agents/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [agents()],
  test: {
    include: [
      "packages/**/*.test.{ts,tsx}",
      "apps/**/*.test.{ts,tsx}",
      "services/**/*.test.{ts,tsx}",
      "tools/**/*.test.{ts,tsx}",
    ],
    coverage: {
      reporter: ["text", "json-summary", "html"],
    },
  },
  lint: {
    ignorePatterns: [
      "**/dist/**",
      "**/.output/**",
      "**/routeTree.gen.ts",
      ".playwright-mcp/**",
      "mods/**",
    ],
  },
  fmt: {
    semi: true,
    singleQuote: false,
    trailingComma: "all",
  },
  run: {
    cache: {
      scripts: true,
      tasks: true,
    },
  },
});
