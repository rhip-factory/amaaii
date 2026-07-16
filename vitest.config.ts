import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Mirrors the path aliases declared in tsconfig.json so tests can import
// @amaaii/core / @amaaii/adapters ahead of any real package code existing.
// Test discovery is intentionally left at Vitest's default (tests/ dir),
// unchanged from the pre-TypeScript setup.
export default defineConfig({
  resolve: {
    alias: {
      "@amaaii/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url)
      ),
      "@amaaii/core/": fileURLToPath(
        new URL("./packages/core/src/", import.meta.url)
      ),
      "@amaaii/adapters": fileURLToPath(
        new URL("./packages/adapters/src/index.ts", import.meta.url)
      ),
      "@amaaii/adapters/": fileURLToPath(
        new URL("./packages/adapters/src/", import.meta.url)
      ),
    },
  },
});
