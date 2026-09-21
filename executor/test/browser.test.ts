/**
 * The warm-browser singleton's recovery paths, driven by a fake launcher —
 * no real Chromium is ever started (the package rule: no test launches a
 * browser).
 */

import type { Browser } from "playwright";
import { afterEach, expect, test } from "vitest";

import { closeWarmBrowser, setBrowserLauncherForTests, warmBrowser } from "../src/browser.js";

function fakeBrowser() {
  const state = { connected: true, closed: false };
  const browser = {
    isConnected: () => state.connected,
    close: async () => {
      state.closed = true;
      state.connected = false;
    },
  } as unknown as Browser;
  return { browser, state };
}

afterEach(async () => {
  await closeWarmBrowser();
});

test("a healthy warm browser is reused, not relaunched", async () => {
  const a = fakeBrowser();
  let launches = 0;
  setBrowserLauncherForTests({
    launch: async () => {
      launches += 1;
      return a.browser;
    },
  });
  const first = await warmBrowser();
  const second = await warmBrowser();
  expect(first).toBe(a.browser);
  expect(second).toBe(a.browser);
  expect(launches).toBe(1);
});

test("a dead Chromium (crash/OOM between calls) is relaunched on the next call", async () => {
  const dead = fakeBrowser();
  const fresh = fakeBrowser();
  const sequence = [dead.browser, fresh.browser];
  setBrowserLauncherForTests({ launch: async () => sequence.shift()! });

  expect(await warmBrowser()).toBe(dead.browser);
  dead.state.connected = false; // the process died

  expect(await warmBrowser()).toBe(fresh.browser);
  // And the relaunched browser is now the cached one.
  expect(await warmBrowser()).toBe(fresh.browser);
  expect(sequence).toHaveLength(0);
});

test("concurrent calls against a dead browser relaunch exactly once", async () => {
  const dead = fakeBrowser();
  let launches = 0;
  const replacements = [fakeBrowser(), fakeBrowser()];
  setBrowserLauncherForTests({
    launch: async () => {
      launches += 1;
      return launches === 1 ? dead.browser : replacements[launches - 2]!.browser;
    },
  });
  await warmBrowser();
  dead.state.connected = false;

  const [a, b, c] = await Promise.all([warmBrowser(), warmBrowser(), warmBrowser()]);
  expect(launches).toBe(2); // the initial launch + ONE relaunch
  expect(a).toBe(b);
  expect(b).toBe(c);
});

test("a failed launch does not poison the singleton — the next call retries", async () => {
  const good = fakeBrowser();
  let calls = 0;
  setBrowserLauncherForTests({
    launch: async () => {
      calls += 1;
      if (calls === 1) throw new Error("browser binary missing");
      return good.browser;
    },
  });
  await expect(warmBrowser()).rejects.toThrow("browser binary missing");
  expect(await warmBrowser()).toBe(good.browser);
});

test("closeWarmBrowser closes and forgets the instance", async () => {
  const a = fakeBrowser();
  const b = fakeBrowser();
  const sequence = [a.browser, b.browser];
  setBrowserLauncherForTests({ launch: async () => sequence.shift()! });

  await warmBrowser();
  await closeWarmBrowser();
  expect(a.state.closed).toBe(true);
  expect(await warmBrowser()).toBe(b.browser);
});
