#!/usr/bin/env node
/**
 * Fail CI on high/critical npm advisories, with one narrowly-scoped exception.
 *
 * aws-cdk-lib bundles brace-expansion@5.0.7, so npm overrides cannot replace
 * it. The reachability and review date for GHSA-mh99-v99m-4gvg are documented
 * in docs/SECURITY.md. Keep the exception tied to both that advisory and the
 * aws-cdk-lib subtree so the same package in application code still fails CI.
 */
import { spawnSync } from "node:child_process";

const ALLOWED_ADVISORIES = new Set(["GHSA-MH99-V99M-4GVG"]);
const ALLOWED_NODE_PREFIX = "node_modules/aws-cdk-lib";
const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

function advisoryId(via) {
  const match = String(via.url ?? "").match(/GHSA-[a-z0-9-]+/i);
  return match?.[0]?.toUpperCase();
}

function advisoryIds(name, vulnerabilities, seen = new Set()) {
  if (seen.has(name)) return new Set();
  seen.add(name);

  const ids = new Set();
  for (const via of vulnerabilities[name]?.via ?? []) {
    if (typeof via === "string") {
      for (const id of advisoryIds(via, vulnerabilities, seen)) ids.add(id);
    } else if (BLOCKING_SEVERITIES.has(via.severity)) {
      const id = advisoryId(via);
      if (id) ids.add(id);
    }
  }
  return ids;
}

const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const args = npmCli ? [npmCli, "audit", "--json"] : ["audit", "--json"];
const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error(result.stderr || result.stdout || result.error?.message || "npm audit produced no JSON");
  process.exit(1);
}

if (report.error || !report.vulnerabilities) {
  console.error(report.error?.summary ?? report.message ?? "npm audit did not return a vulnerability report");
  process.exit(1);
}

const blocked = [];
const accepted = [];
for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
  if (!BLOCKING_SEVERITIES.has(vulnerability.severity)) continue;

  const ids = [...advisoryIds(name, report.vulnerabilities)];
  const nodes = vulnerability.nodes ?? [];
  const isAllowed =
    ids.length > 0 &&
    ids.every((id) => ALLOWED_ADVISORIES.has(id)) &&
    nodes.length > 0 &&
    nodes.every((node) => node === ALLOWED_NODE_PREFIX || node.startsWith(`${ALLOWED_NODE_PREFIX}/`));

  (isAllowed ? accepted : blocked).push({ name, severity: vulnerability.severity, ids, nodes });
}

for (const finding of accepted) {
  console.warn(
    `accepted ${finding.severity} advisory for ${finding.name}: ${finding.ids.join(", ")} (docs/SECURITY.md)`,
  );
}

if (blocked.length > 0) {
  for (const finding of blocked) {
    console.error(
      `blocking ${finding.severity} vulnerability: ${finding.name} ${finding.ids.join(", ") || "(unresolved advisory chain)"}`,
    );
  }
  process.exit(1);
}

console.log("npm audit: no unaccepted high or critical vulnerabilities");
