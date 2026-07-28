/**
 * Ship something a site can actually drop onto a page (#215).
 *
 * The package is TypeScript source with a bare `jose` import, which means an
 * integrator needs npm, a bundler and a build step before they can check whether
 * a reader has paid. That is a lot of setup to ask of a marketing site, and it
 * is the reason the client half of the integration keeps getting written by hand.
 *
 * Two artifacts, both with `jose` bundled in:
 *   - ESM  — `import { consume } from ".../addressium-magiclink.esm.js"`
 *   - IIFE — `<script src="...">` then `window.addressiumMagicLink.consume(...)`
 *
 * The SRI hash is printed because a third-party script tag without one is a
 * standing supply-chain hole: whoever can change the file can read every
 * subscriber id on the page.
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const shared = {
  entryPoints: ["src/browser.ts"],
  bundle: true,
  minify: true,
  // Modern only, deliberately. Downleveling `jose` to ES5 would pull in polyfills
  // for the WebCrypto primitives it deliberately delegates to the platform, and a
  // browser without SubtleCrypto cannot verify an ES256 signature anyway.
  target: ["es2020"],
  platform: "browser",
  sourcemap: true,
  logLevel: "warning",
};

const outputs = [
  { ...shared, format: "esm", outfile: "dist/addressium-magiclink.esm.js" },
  {
    ...shared,
    format: "iife",
    globalName: "addressiumMagicLink",
    outfile: "dist/addressium-magiclink.iife.js",
  },
];

for (const opts of outputs) {
  await build(opts);
  const bytes = readFileSync(opts.outfile);
  const sri = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
  writeFileSync(`${opts.outfile}.sri`, `${sri}\n`);
  console.log(`${opts.outfile}  ${(bytes.length / 1024).toFixed(1)} KB  ${sri}`);
}
