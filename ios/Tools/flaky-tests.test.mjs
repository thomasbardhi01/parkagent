// node --test ios/Tools/flaky-tests.test.mjs
// The report below is `xcresulttool get test-results tests` output (Xcode
// 26) from a real run with -retry-tests-on-failure -test-iterations 2:
// one test that failed then passed, one that failed twice, one that passed.

import assert from "node:assert/strict";
import { test } from "node:test";

import { flakyTests } from "./flaky-tests.mjs";

const failure = (name) => [{ name, nodeType: "Failure Message" }];
const REPORT = {
  testNodes: [
    {
      name: "ParkAgent",
      nodeType: "Test Plan",
      result: "Failed",
      children: [
        {
          name: "iPhone 17 Pro Max",
          nodeType: "Device",
          children: [
            {
              name: "ParkAgentUITests",
              nodeType: "UI test bundle",
              result: "Failed",
              children: [
                {
                  name: "WalletUITests",
                  nodeType: "Test Suite",
                  result: "Failed",
                  children: [
                    {
                      name: "testLinkNotConfigured()",
                      nodeType: "Test Case",
                      nodeIdentifier: "WalletUITests/testLinkNotConfigured()",
                      result: "Passed",
                      children: [
                        {
                          name: "First Run",
                          nodeType: "Repetition",
                          nodeIdentifier: "1",
                          result: "Failed",
                          children: failure(
                            "ParkAgentUITestCase.swift:107: XCTAssertTrue failed - Wallet tab missing",
                          ),
                        },
                        { name: "Retry 1", nodeType: "Repetition", nodeIdentifier: "2", result: "Passed" },
                      ],
                    },
                    {
                      name: "testAlwaysFails()",
                      nodeType: "Test Case",
                      nodeIdentifier: "WalletUITests/testAlwaysFails()",
                      result: "Failed",
                      children: [
                        { name: "First Run", nodeType: "Repetition", result: "Failed", children: failure("x") },
                        { name: "Retry 1", nodeType: "Repetition", result: "Failed", children: failure("x") },
                      ],
                    },
                    {
                      name: "testParkAgentCardSandbox()",
                      nodeType: "Test Case",
                      nodeIdentifier: "WalletUITests/testParkAgentCardSandbox()",
                      result: "Passed",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

test("a test that passed only on its retry is flaky, with its first failure", () => {
  assert.deepEqual(flakyTests(REPORT), [
    {
      id: "WalletUITests/testLinkNotConfigured()",
      failure: "ParkAgentUITestCase.swift:107: XCTAssertTrue failed - Wallet tab missing",
    },
  ]);
});

test("a run with no retries has no flaky tests", () => {
  assert.deepEqual(flakyTests({ testNodes: [] }), []);
  assert.deepEqual(flakyTests({}), []);
});
