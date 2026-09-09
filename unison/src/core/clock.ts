/**
 * Time sources used by the sync pipeline.
 *
 * Every latency calculation in this app is a *difference* between two readings of the same
 * monotonic clock, so wall-clock adjustments (NTP, user changing the time) can never corrupt
 * a measurement. Wall time is only used when we have to compare against a server timestamp.
 */
export interface Clock {
  /** Monotonic milliseconds from an arbitrary origin (performance.now when available). */
  now(): number;
  /** Unix epoch milliseconds. Only for comparisons with server-provided timestamps. */
  wallNow(): number;
}

type MaybePerformance = { performance?: { now?: () => number } };

export const systemClock: Clock = {
  now: () => {
    const perf = (globalThis as MaybePerformance).performance;
    return typeof perf?.now === 'function' ? perf.now() : Date.now();
  },
  wallNow: () => Date.now(),
};

/** Deterministic clock for unit tests. */
export class FakeClock implements Clock {
  private t: number;
  private readonly wallOrigin: number;

  constructor(start = 0, wallOrigin = 1_700_000_000_000) {
    this.t = start;
    this.wallOrigin = wallOrigin;
  }

  now(): number {
    return this.t;
  }

  wallNow(): number {
    return this.wallOrigin + this.t;
  }

  advance(ms: number): number {
    this.t += ms;
    return this.t;
  }

  set(ms: number): void {
    this.t = ms;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
