import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STARTUP_LATENCY_MS,
  createStartupLatencyModel,
  measureStartupLatency,
  probeMidpoint,
  updateStartupLatency,
} from '../core/sync/calibration';

describe('startup latency model', () => {
  it('starts from a conservative default with zero samples', () => {
    expect(createStartupLatencyModel()).toEqual({ estimateMs: DEFAULT_STARTUP_LATENCY_MS, samples: 0 });
  });

  it('replaces the default with the first measurement, then smooths with an EMA', () => {
    const first = updateStartupLatency(createStartupLatencyModel(), 600);
    expect(first).toMatchObject({ estimateMs: 600, samples: 1, lastMeasuredMs: 600 });
    const second = updateStartupLatency(first, 400, 0.5);
    expect(second).toMatchObject({ estimateMs: 500, samples: 2, lastMeasuredMs: 400 });
  });

  it('clamps measurements to the plausible range', () => {
    expect(updateStartupLatency(createStartupLatencyModel(), -500).estimateMs).toBe(0);
    expect(updateStartupLatency(createStartupLatencyModel(), 99_999).estimateMs).toBe(4000);
  });
});

describe('measureStartupLatency', () => {
  it('derives the latency from a playback probe', () => {
    // Asked for 60 000 at t=1000. Probe sent at 1500, back at 1700 (midpoint 1600) reports 60 250.
    // 250 ms have played, so audio started at 1350 → latency 350 ms.
    const probe = { progressMs: 60_250, requestSentAt: 1500, responseReceivedAt: 1700 };
    expect(probeMidpoint(probe)).toBe(1600);
    expect(measureStartupLatency({ requestedPositionMs: 60_000, dispatchAt: 1000, probe })).toBe(350);
  });

  it('rejects probes taken before playback reached the requested position', () => {
    const probe = { progressMs: 59_000, requestSentAt: 1500, responseReceivedAt: 1700 };
    expect(measureStartupLatency({ requestedPositionMs: 60_000, dispatchAt: 1000, probe })).toBeNull();
  });

  it('rejects wildly implausible values', () => {
    const probe = { progressMs: 90_000, requestSentAt: 1500, responseReceivedAt: 1700 };
    expect(measureStartupLatency({ requestedPositionMs: 60_000, dispatchAt: 1000, probe })).toBeNull();
  });
});
