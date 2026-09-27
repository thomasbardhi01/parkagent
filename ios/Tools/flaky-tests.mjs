#!/usr/bin/env node
// The tests a run only passed on a retry (CI's ui-tests job runs xcodebuild
// with -retry-tests-on-failure -test-iterations 2).
//
//   xcrun xcresulttool get test-results tests --path TestResults.xcresult --compact > tests.json
//   node ios/Tools/flaky-tests.mjs tests.json
//
// Prints one JSON line per test whose result is Passed but which has a
// failed repetition: {id, failure} — the id as xcodebuild's -only-testing
// takes it ("WalletUITests/testLinkNotConfigured()"), and the first failed
// attempt's message. A test that failed every attempt is a failure, not a
// flake, and isn't listed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function flakyTests(report) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.nodeType === "Test Case") {
      const repetitions = (node.children ?? []).filter((c) => c.nodeType === "Repetition");
      const failed = repetitions.find((r) => r.result === "Failed");
      if (node.result === "Passed" && failed) {
        const message = (failed.children ?? []).find((c) => c.nodeType === "Failure Message");
        found.push({ id: node.nodeIdentifier ?? node.name, failure: message?.name ?? "(no message)" });
      }
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const node of report.testNodes ?? []) walk(node);
  return found;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: flaky-tests.mjs <xcresulttool tests.json>");
    process.exit(2);
  }
  for (const flaky of flakyTests(JSON.parse(readFileSync(path, "utf8")))) {
    console.log(JSON.stringify(flaky));
  }
}
