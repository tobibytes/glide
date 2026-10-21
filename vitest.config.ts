import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@engine": fileURLToPath(new URL("./src/engine", import.meta.url)),
    },
  },
});
