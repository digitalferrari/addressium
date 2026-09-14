import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Public subscriber site → static assets on S3 + CloudFront (docs/ARCHITECTURE.md §4.1).
export default defineConfig({
  plugins: [react()],
  // Served from a SUBPATH, not the root. subscriber-web and public-web share one
  // bucket and one distribution (control-plane-stack.ts, `PublicSite`), and
  // subscriber-web has to own `/` because the `/confirm` and `/unsubscribe`
  // links in outgoing email resolve there — an unsubscribe link that 404s is a
  // CAN-SPAM problem, not a routing inconvenience. Without this, both apps build
  // to `/` and whichever `aws s3 sync` ran last silently replaces the other's
  // index.html.
  //
  // Note this also moves the embeddable widget to `/signup/embed.js`; that is
  // the URL operators must paste, and the snippet in public/embed.js says so.
  base: "/signup/",
  build: { outDir: "dist", sourcemap: true },
  // The component tests render into a DOM, so `node` is not an option. Pinned
  // here rather than passed on the command line: the suite was unrunnable
  // without knowing to add --environment jsdom, which is the same as having no
  // suite. `setupTests` brings in jest-dom's matchers (toBeDisabled and friends).
  test: { environment: "jsdom", setupFiles: ["./src/setupTests.ts"] },
});
