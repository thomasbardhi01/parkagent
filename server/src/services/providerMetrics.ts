/**
 * The provider half of /admin/summary: how long each stage of talking to a
 * parking provider took today (p50/p95), and how often it timed out,
 * retried, or tripped the circuit breaker — per provider. Pure: it reads
 * rows the caller already loaded (link jobs and decisions) plus the live
 * breaker and gate, so it is unit-tested without a database.
 */

import type { LinkJobRow } from "../db.js";
import { cityForZone, providerForCity } from "../providers/registry.js";
import type { BreakerState } from "./circuitBreaker.js";

export interface StageStats {
  n: number;
  p50Ms: number;
  p95Ms: number;
}

export interface ProviderReliability {
  /** queue (waiting for a browser slot), verify, card (the saved-card
   * read), setup, link (whole link, request to done), start, extend, stop. */
  stages: Record<string, StageStats>;
  timeouts: number;
  retries: number;
  breakerTrips: number;
  breakerState: BreakerState | null;
  links: { started: number; done: number; failed: number; retrying: number; deadLettered: number };
}

/** Nearest-rank percentile of already-collected samples. */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return Math.round(sorted[rank - 1]!);
}

interface DecisionLike {
  kind: string;
  rule: string;
  inputs: unknown;
  outcome: unknown;
}

interface ExecutorMeta {
  queueMs?: number;
  runMs?: number;
  retries?: number;
}

interface Outcome {
  code?: string;
  durationMs?: number;
  executor?: ExecutorMeta;
  quote?: { zoneId?: string } | null;
}

export function providerReliability(args: {
  linkJobs: LinkJobRow[];
  decisions: DecisionLike[];
  /** Session id → city, for decisions that only name their session. */
  sessionCity: Map<string, string>;
  decisionSession: (decision: DecisionLike) => string | null;
  breakerState?: (provider: string) => BreakerState;
}): Record<string, ProviderReliability> {
  const byProvider: Record<string, ProviderReliability> = {};
  const samples: Record<string, Record<string, number[]>> = {};
  const entry = (provider: string) => {
    byProvider[provider] ??= {
      stages: {},
      timeouts: 0,
      retries: 0,
      breakerTrips: 0,
      breakerState: args.breakerState?.(provider) ?? null,
      links: { started: 0, done: 0, failed: 0, retrying: 0, deadLettered: 0 },
    };
    samples[provider] ??= {};
    return byProvider[provider]!;
  };
  const sample = (provider: string, stage: string, ms: number | undefined) => {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return;
    entry(provider);
    (samples[provider]![stage] ??= []).push(ms);
  };

  for (const job of args.linkJobs) {
    const summary = entry(job.provider);
    summary.links.started += 1;
    if (job.phase === "done") summary.links.done += 1;
    else if (job.phase === "failed") summary.links.failed += 1;
    else if (job.phase === "retrying") summary.links.retrying += 1;
    if (job.deadAt) summary.links.deadLettered += 1;
    if (job.reason === "timeout") summary.timeouts += 1;
    summary.retries += Math.max(0, job.attempts - 1);
    const stages = (job.stages ?? {}) as Record<string, number>;
    sample(job.provider, "queue", stages.queueMs);
    sample(job.provider, "verify", stages.verifyMs);
    sample(job.provider, "card", stages.cardMs);
    sample(job.provider, "setup", stages.setupMs);
    if (job.phase === "done") sample(job.provider, "link", stages.totalMs);
  }

  const stageFor: Record<string, string> = {
    session_start: "start",
    session_extend: "extend",
    session_stop: "stop",
    extend_tick: "extend",
  };
  for (const decision of args.decisions) {
    if (decision.kind === "circuit_breaker") {
      const provider = (decision.inputs as { provider?: string }).provider;
      if (provider && decision.rule === "open") entry(provider).breakerTrips += 1;
      continue;
    }
    const stage = stageFor[decision.kind];
    if (!stage) continue;
    const outcome = (decision.outcome ?? {}) as Outcome;
    // Only calls that reached a real provider carry executor meta.
    if (!outcome.executor) continue;
    const sessionId = args.decisionSession(decision);
    const city =
      (sessionId ? args.sessionCity.get(sessionId) : undefined) ??
      (outcome.quote?.zoneId ? cityForZone(outcome.quote.zoneId) : null);
    const provider = providerForCity(city ?? null)?.id;
    if (!provider) continue;
    const summary = entry(provider);
    sample(provider, "queue", outcome.executor.queueMs);
    sample(provider, stage, outcome.executor.runMs ?? outcome.durationMs);
    summary.retries += outcome.executor.retries ?? 0;
    if (outcome.code === "timeout" || outcome.code === "busy") summary.timeouts += 1;
  }

  for (const [provider, stages] of Object.entries(samples)) {
    for (const [stage, values] of Object.entries(stages)) {
      byProvider[provider]!.stages[stage] = {
        n: values.length,
        p50Ms: percentile(values, 50),
        p95Ms: percentile(values, 95),
      };
    }
  }
  return byProvider;
}
