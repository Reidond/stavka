import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    dedupe: ["react", "react-dom", "three"],
  },
  plugins: [
    agents(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    react(),
    tailwindcss(),
  ],
});
