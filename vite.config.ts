import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Single config for both `vite build` and `vitest`. A separate
// vitest.config.ts would take precedence for tests and silently drop the
// `@` alias defined here, so build and test would resolve differently.
const host = process.env.TAURI_DEV_HOST;

// `mode` is "test" under vitest. Endpoints must not leak from .env.local into
// tests — see src/test/env/README.md for why envDir is the lever and test.env
// is not.
export default defineConfig(({ mode }) => ({
  envDir: mode === "test" ? path.resolve(__dirname, "./src/test/env") : undefined,
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // tauri.conf.json pins devUrl to http://localhost:1420, so the port must be
  // fixed rather than auto-incremented, and Vite must not watch the Rust tree
  // or every cargo rebuild retriggers the frontend.
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    // Parallel-session worktrees under .claude/worktrees/ (see Task 18/19/20/21
    // MERGE-NOTES rows) are picked up by vitest's default glob and double-count
    // that sibling checkout's own tests. Extend, don't replace, the defaults.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
}));
