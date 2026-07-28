import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Public subscriber site → static assets on S3 + CloudFront (docs/ARCHITECTURE.md §4.1).
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: true },
  // The component tests render into a DOM, so `node` is not an option. Pinned
  // here rather than passed on the command line: the suite was unrunnable
  // without knowing to add --environment jsdom, which is the same as having no
  // suite. `setupTests` brings in jest-dom's matchers (toBeDisabled and friends).
  test: { environment: "jsdom", setupFiles: ["./src/setupTests.ts"] },
});
