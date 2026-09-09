import { describe, expect, it } from 'vitest';

import { ambientPositionAt, computeTargetPosition, referencePositionAtCaptureEnd, type CaptureTimings } from '../core/sync/latency';

const timings: CaptureTimings = {
  captureStart: 10_000,
  captureEnd: 16_000, // 6 s recording
  uploadStart: 16_080, // 80 ms to finalise the file + build the request
  responseReceived: 16_980, // 900 ms upload + ACRCloud + download
};

describe('referencePositionAtCaptureEnd', () => {
  it('uses play_offset_ms directly when anchored to the sample end (default)', () => {
    expect(referencePositionAtCaptureEnd({ playOffsetMs: 60_000 }, 6000)).toEqual({ positionMs: 60_000, anchorUsed: 'sample_end' });
  });

  it('adds the capture length when anchored to the sample start', () => {
    expect(referencePositionAtCaptureEnd({ playOffsetMs: 60_000 }, 6000, 'sample_start')).toEqual({ positionMs: 66_000, anchorUsed: 'sample_start' });
  });

  it('prefers the db/sample end offsets and extrapolates to the end of the capture', () => {
    // Match ended 5.8 s into a 6 s file at reference 61 230 ms → at capture end the reference is 61 430 ms.
    const ref = referencePositionAtCaptureEnd({ playOffsetMs: 61_230, sampleEndOffsetMs: 5800, dbEndOffsetMs: 61_230 }, 6000, 'sample_start');
    expect(ref).toEqual({ positionMs: 61_430, anchorUsed: 'db_offsets' });
  });

  it('clamps absurd extrapolations', () => {
    const ref = referencePositionAtCaptureEnd({ playOffsetMs: 0, sampleEndOffsetMs: 60_000, dbEndOffsetMs: 100_000 }, 6000);
    expect(ref.positionMs).toBe(99_000);
  });
});

describe('computeTargetPosition', () => {
  it('adds everything that elapsed after the recording stopped, plus startup latency and trim', () => {
    const result = computeTargetPosition({
      match: { playOffsetMs: 60_000, durationMs: 200_000 },
      timings,
      dispatchAt: 17_000, // 20 ms after the response arrived
      startupLatencyMs: 350,
      userTrimMs: -30,
    });
    // 60 000 + (17 000 − 16 000) + 350 − 30
    expect(result.positionMs).toBe(61_320);
    expect(result.referencePositionAtCaptureEndMs).toBe(60_000);
    expect(result.trackWillHaveEnded).toBe(false);
    expect(result.remainingMs).toBe(200_000 - 61_320);
    expect(result.breakdown).toEqual({
      captureMs: 6000,
      encodeAndPrepareMs: 80,
      networkRoundTripMs: 900,
      acrProcessingMs: undefined,
      decisionMs: 20,
      elapsedSinceCaptureEndMs: 1000,
      startupLatencyMs: 350,
      userTrimMs: -30,
      totalCompensationMs: 1320,
      anchorUsed: 'sample_end',
    });
  });

  it('never returns a negative position', () => {
    const result = computeTargetPosition({ match: { playOffsetMs: 100 }, timings, dispatchAt: 17_000, startupLatencyMs: 0, userTrimMs: -5000 });
    expect(result.positionMs).toBe(0);
  });

  it('flags a sync that would land after the end of the track', () => {
    const result = computeTargetPosition({ match: { playOffsetMs: 199_500, durationMs: 200_000 }, timings, dispatchAt: 17_000, startupLatencyMs: 350 });
    expect(result.trackWillHaveEnded).toBe(true);
  });

  it('rounds to whole milliseconds', () => {
    const result = computeTargetPosition({ match: { playOffsetMs: 1000 }, timings: { ...timings, captureEnd: 16_000.4 }, dispatchAt: 17_000.2, startupLatencyMs: 0 });
    expect(Number.isInteger(result.positionMs)).toBe(true);
  });
});

describe('ambientPositionAt', () => {
  it('extrapolates linearly', () => {
    expect(ambientPositionAt(60_000, 16_000, 20_000)).toBe(64_000);
  });
});
