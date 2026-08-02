import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/dashboard",
  plugins: [tailwindcss(), react()],
  base: "/_/",
  build: {
    outDir: "../../dist/dashboard",
    emptyOutDir: true,
  },
});
