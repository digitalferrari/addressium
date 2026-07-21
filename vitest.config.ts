import { defineConfig } from "vitest/config";

// Component/unit tests for the React SPAs (#98). Backend keeps its node:test
// suites (`npm test`); this runs the web tests (`npm run test:web`).
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["apps/**/src/**/*.test.{ts,tsx}"],
  },
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
});
