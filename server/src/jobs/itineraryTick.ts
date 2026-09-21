/**
 * The signed-off day's minder, every 60 s:
 * - 15 minutes before a garage stop's arrival, push its deep link so the
 *   pass (or checkout) is one tap away at the curb. Once per stop.
 * - Attach street sessions to their stops: a session of the user that
 *   started inside a stop's window links in, so Home can show live
 *   status per stop.
 * - A day whose last stop's window has passed is marked done.
 * Every push writes a decisions row.
 */

import type { AppDb } from "../db.js";
import { itineraryGaragePush } from "../services/apns.js";
import type { PushSender } from "../services/apns.js";

const GARAGE_PUSH_LEAD_MS = 15 * 60_000;

export interface ItineraryTickDeps {
  db: AppDb;
  sendPush: PushSender;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  now?: () => Date;
}

interface StopState {
  id: string;
  label: string;
  choice: "street" | "garage";
  arrival: string;
  durationMinutes: number;
  deepLink?: string;
  sessionId?: string | null;
  garageLinkPushedAt?: string | null;
  [key: string]: unknown;
}

export interface ItineraryWorker {
  tick(): Promise<void>;
  start(intervalMs?: number): void;
  stop(): void;
}

export function makeItineraryWorker(deps: ItineraryTickDeps): ItineraryWorker {
  const now = () => deps.now?.() ?? new Date();

  async function evaluate(itinerary: {
    id: string;
    userId: string;
    stops: unknown;
  }): Promise<void> {
    const at = now();
    const stops = itinerary.stops as StopState[];
    let changed = false;
    let lastEnd = 0;

    const sessions = await deps.db.session.findMany({
      where: { userId: itinerary.userId, createdAt: { gte: new Date(at.getTime() - 24 * 60 * 60_000) } },
    });

    for (const stop of stops) {
      const arrival = new Date(stop.arrival).getTime();
      const end = arrival + stop.durationMinutes * 60_000;
      lastEnd = Math.max(lastEnd, end);

      if (
        stop.choice === "garage" &&
        stop.deepLink &&
        !stop.garageLinkPushedAt &&
        at.getTime() >= arrival - GARAGE_PUSH_LEAD_MS &&
        at.getTime() < end
      ) {
        await deps.sendPush(
          itinerary.userId,
          itineraryGaragePush({
            stopLabel: stop.label,
            itineraryId: itinerary.id,
            stopId: stop.id,
            deepLink: stop.deepLink,
          }),
        );
        await deps.db.decision.create({
          data: {
            kind: "assistant_confirm",
            inputs: { itineraryId: itinerary.id, stopId: stop.id },
            rule: "garage_link_pushed",
            outcome: { deepLink: stop.deepLink },
            userId: itinerary.userId,
          },
        });
        stop.garageLinkPushedAt = at.toISOString();
        changed = true;
      }

      if (stop.choice === "street" && !stop.sessionId) {
        const match = sessions.find((s) => {
          const started = (s.startedAt ?? s.createdAt).getTime();
          return started >= arrival - 30 * 60_000 && started <= end;
        });
        if (match) {
          stop.sessionId = match.id;
          changed = true;
        }
      }
    }

    if (changed) {
      await deps.db.itinerary.update({ where: { id: itinerary.id }, data: { stops } });
    }
    if (lastEnd > 0 && at.getTime() > lastEnd) {
      await deps.db.itinerary.update({ where: { id: itinerary.id }, data: { status: "done" } });
    }
  }

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const active = await deps.db.itinerary.findMany({ where: { status: "signed_off" } });
      for (const itinerary of active) {
        try {
          await evaluate(itinerary);
        } catch (err) {
          deps.log.warn(`itinerary tick failed for ${itinerary.id}: ${String(err)}`);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start(intervalMs = 60_000) {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      deps.log.info(`itinerary worker started (every ${intervalMs / 1000}s)`);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
