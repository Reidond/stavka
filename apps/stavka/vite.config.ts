import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig(({ command, mode }) => ({
  resolve: {
    dedupe: ["react", "react-dom", "three"],
  },
  plugins: [
    agents(),
    cloudflare({
      viteEnvironment: { name: "ssr" },
      ...(command === "serve" && mode === "local-account"
        ? {
            remoteBindings: false,
            auxiliaryWorkers: [
              { configPath: "../../services/commander/wrangler.jsonc", devOnly: true },
              {
                configPath: "../../services/inference/wrangler.jsonc",
                config: { assets: undefined },
                devOnly: true,
              },
            ],
          }
        : {}),
    }),
    tanstackStart(),
    react(),
    tailwindcss(),
  ],
}));
