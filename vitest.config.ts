import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], testTimeout: 15000 },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
