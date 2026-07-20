import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Admin SPA → static assets on S3 + CloudFront (docs/ARCHITECTURE.md §4.1).
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: true },
});
