import { describe, expect, it } from 'vitest';

import { decideDriftCorrection } from '../core/sync/drift';

describe('decideDriftCorrection', () => {
  it('normalises both readings to now and does nothing inside the threshold', () => {
    const decision = decideDriftCorrection({
      ambient: { positionMs: 70_000, at: 30_000 },
      player: { positionMs: 70_950, at: 31_000 },
      nowMs: 32_000,
    });
    // ambient now = 72 000, player now = 71 950 → +50 ms, within 120 ms
    expect(decision).toEqual({ driftMs: 50, action: 'none' });
  });

  it('seeks forward (plus seek latency) when the player is behind the room', () => {
    const decision = decideDriftCorrection({
      ambient: { positionMs: 70_000, at: 30_000 },
      player: { positionMs: 69_500, at: 30_000 },
      nowMs: 31_000,
      seekLatencyMs: 200,
    });
    expect(decision).toEqual({ driftMs: 500, action: 'seek', seekToMs: 71_200 });
  });

  it('seeks backwards when the player is ahead', () => {
    const decision = decideDriftCorrection({
      ambient: { positionMs: 70_000, at: 30_000 },
      player: { positionMs: 70_400, at: 30_000 },
      nowMs: 30_000,
    });
    expect(decision).toEqual({ driftMs: -400, action: 'seek', seekToMs: 70_000 });
  });

  it('honours an intentional listener offset (manual trim)', () => {
    // Listener wants to run 150 ms ahead of the room; player is exactly 150 ms ahead → no drift.
    const decision = decideDriftCorrection({
      ambient: { positionMs: 70_000, at: 30_000 },
      player: { positionMs: 70_150, at: 30_000 },
      nowMs: 30_000,
      targetOffsetMs: 150,
    });
    expect(decision).toEqual({ driftMs: 0, action: 'none' });
  });

  it('asks for a full resync when the two passes cannot be the same playback', () => {
    const decision = decideDriftCorrection({
      ambient: { positionMs: 10_000, at: 0 },
      player: { positionMs: 100_000, at: 0 },
      nowMs: 0,
    });
    expect(decision.action).toBe('resync');
  });
});
