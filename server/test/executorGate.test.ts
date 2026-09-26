/**
 * The browser gate: at most `capacity` provider calls at once, the rest in
 * arrival order, each told its place in line; a bounded wait fails "busy"
 * with nothing run, and a slot is always handed back.
 */

import { expect, test } from "vitest";

import { ExecutorGate, GateWaitError } from "../src/services/executorGate.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("runs up to capacity at once and the rest in arrival order", async () => {
  const gate = new ExecutorGate(2);
  const order: string[] = [];
  const releases: (() => void)[] = [];
  const job = (name: string) =>
    gate.run(async () => {
      order.push(`start ${name}`);
      await new Promise<void>((resolve) => releases.push(resolve));
      order.push(`end ${name}`);
    });
  const all = [job("a"), job("b"), job("c"), job("d")];
  await tick();
  expect(order).toEqual(["start a", "start b"]);
  expect(gate.queued).toBe(2);
  releases.shift()!();
  await tick();
  await tick();
  expect(order).toContain("start c");
  expect(order).not.toContain("start d");
  while (releases.length) {
    releases.shift()!();
    await tick();
    await tick();
  }
  await Promise.all(all);
  expect(order.filter((e) => e.startsWith("start"))).toEqual([
    "start a",
    "start b",
    "start c",
    "start d",
  ]);
  expect(gate.inUse).toBe(0);
});

test("each waiter hears its place in line, and 0 when its turn comes", async () => {
  const gate = new ExecutorGate(1);
  const first = await gate.acquire();
  const heardB: number[] = [];
  const heardC: number[] = [];
  const b = gate.acquire({ onPosition: (n) => heardB.push(n) });
  const c = gate.acquire({ onPosition: (n) => heardC.push(n) });
  expect(heardB).toEqual([1]);
  expect(heardC).toEqual([2]);
  first.release();
  const ticketB = await b;
  expect(heardB.at(-1)).toBe(0);
  expect(heardC.at(-1)).toBe(1);
  expect(ticketB.queuedBehind).toBe(1);
  ticketB.release();
  (await c).release();
  expect(heardC.at(-1)).toBe(0);
});

test("a bounded wait fails busy, leaves the line, and nothing ran", async () => {
  const gate = new ExecutorGate(1);
  const held = await gate.acquire();
  let ran = false;
  await expect(
    gate.run(
      async () => {
        ran = true;
      },
      { maxWaitMs: 20 },
    ),
  ).rejects.toMatchObject({ reason: "busy" });
  expect(ran).toBe(false);
  expect(gate.queued).toBe(0);
  held.release();
  expect(gate.inUse).toBe(0);
});

test("an abort while waiting leaves the line", async () => {
  const gate = new ExecutorGate(1);
  const held = await gate.acquire();
  const controller = new AbortController();
  const waiting = gate.acquire({ signal: controller.signal });
  controller.abort();
  await expect(waiting).rejects.toBeInstanceOf(GateWaitError);
  expect(gate.queued).toBe(0);
  held.release();
});

test("a call that throws still hands its slot back", async () => {
  const gate = new ExecutorGate(1);
  await expect(gate.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  expect(gate.inUse).toBe(0);
  const next = await gate.acquire({ maxWaitMs: 10 });
  next.release();
});
