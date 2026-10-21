#!/usr/bin/env node
// The feature map check (.github/workflows/ci.yml, `city-neutral` job).
//
//   node scripts/check-feature-map.mjs
//
// docs/feature-map.md says where every feature lives. This FAILS when:
//   - a repo path the map names in backticks doesn't exist, or its
//     `path:line` points past the end of the file;
//   - a file in server/src/routes/ or server/src/jobs/ is never named;
//   - an endpoint a route file registers (`app.post("/x", …)`) is never
//     written as `POST /x` in the map.
//
// Node built-ins only: the job runs on the runner's own Node, no install.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MAP = "docs/feature-map.md";
export const ROUTES = "server/src/routes";
export const JOBS = "server/src/jobs";

const EXT =
  /\.(ts|tsx|mjs|js|swift|py|md|mmd|yml|yaml|json|sh|toml|txt|gpx|plist|xcconfig|prisma|sql)$/;

/** Every backticked token that reads as a repo path, as
 * { path, line?, raw }. A path has no spaces, doesn't start with `/`
 * (that's an endpoint), and either ends in a known extension or in `/`
 * (a directory). `path:12` and `path:12-30` carry a line. */
export function extractPaths(text) {
  const out = [];
  for (const [, raw] of text.matchAll(/`([^`\n]+)`/g)) {
    if (/\s/.test(raw) || raw.startsWith("/")) continue;
    const m = raw.match(/^(.+?)(?::(\d+)(?:-\d+)?)?$/);
    const path = m[1];
    if (!EXT.test(path) && !path.endsWith("/")) continue;
    out.push({ raw, path, line: m[2] ? Number(m[2]) : undefined });
  }
  return out;
}

/** The endpoints a route file registers, as "METHOD /path". */
export function extractEndpoints(source) {
  const out = [];
  const re = /\.(get|post|put|patch|delete)\s*(?:<[^(]*?>)?\(\s*["'`](\/[^"'`]*)["'`]/g;
  for (const [, method, path] of source.matchAll(re)) {
    out.push(`${method.toUpperCase()} ${path}`);
  }
  return out;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Problems with the map at `root`, one string each; empty means clean. */
export function checkFeatureMap(root = ROOT) {
  const problems = [];
  const mapFile = join(root, MAP);
  if (!existsSync(mapFile)) return [`${MAP} is missing`];
  const text = readFileSync(mapFile, "utf8");

  const named = new Set();
  for (const { raw, path, line } of extractPaths(text)) {
    named.add(path);
    const abs = join(root, path);
    if (!existsSync(abs)) {
      problems.push(`\`${raw}\`: no such path`);
      continue;
    }
    if (path.endsWith("/") && !statSync(abs).isDirectory()) {
      problems.push(`\`${raw}\`: not a directory`);
    }
    if (line !== undefined && statSync(abs).isFile()) {
      const lines = readFileSync(abs, "utf8").split("\n").length;
      if (line < 1 || line > lines) {
        problems.push(`\`${raw}\`: ${path} has ${lines} lines`);
      }
    }
  }

  for (const dir of [ROUTES, JOBS]) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)
      .filter((f) => f.endsWith(".ts"))
      .sort()) {
      const path = `${dir}/${f}`;
      if (!named.has(path)) problems.push(`${path}: not in any row`);
      if (dir !== ROUTES) continue;
      for (const ep of extractEndpoints(readFileSync(join(abs, f), "utf8"))) {
        // `GET /card` must not be satisfied by `GET /card/reveal`.
        if (!new RegExp(`${escape(ep)}(?![\\w/:.-])`).test(text)) {
          problems.push(`${path}: \`${ep}\` not in any row`);
        }
      }
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkFeatureMap();
  if (problems.length) {
    console.error(`${MAP} is out of date:`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error("Fix the path, or add the route/job to its feature's row (CLAUDE.md).");
    process.exit(1);
  }
  console.log(`${MAP}: every path exists; every route and job is placed.`);
}
