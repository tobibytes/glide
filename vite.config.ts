import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@engine": fileURLToPath(new URL("./src/engine", import.meta.url)),
    },
  },
  build: { outDir: "../../dist/renderer", emptyOutDir: true, target: "chrome130" },
  server: { port: 5174, strictPort: true },
});
