import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Admin SPA → static assets on S3 + CloudFront (docs/ARCHITECTURE.md §4.1).
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: true },
  // jsdom, not node: `auth.ts` reads `window.location.origin` at module load to
  // derive the OAuth redirect, so importing anything that touches `api.ts` in a
  // bare node environment throws before a single test runs.
  test: { environment: "jsdom" },
});
