import { describe, expect, it, vi } from 'vitest';

import type { IdentifyResult } from '../core/acrcloud/identify';
import type { AcrSignedFields } from '../core/acrcloud/signing';
import type { AcrMatch } from '../core/acrcloud/types';
import { FakeClock } from '../core/clock';
import type { CapturedSample } from '../core/sample';
import type { PlayReceipt, TimedPlaybackState } from '../core/spotify/client';
import type { SpotifyPlaybackState } from '../core/spotify/types';
import { createStartupLatencyModel, type StartupLatencyModel } from '../core/sync/calibration';
import { DEFAULT_SYNC_OPTIONS, SyncSession, type SyncDeps, type SyncEvent } from '../orchestrator/syncSession';

/**
 * A miniature world: an ambient source playing a track, a Spotify device with a fixed true startup
 * latency, and a FakeClock everything reads from. The test asserts the pipeline lands within the
 * device's true latency error on the first pass and corrects it on the second.
 */
function makeWorld(opts: { trueStartupLatencyMs: number; ambientPosAtT0: number; identifyRoundTripMs?: number; initialModel?: StartupLatencyModel | null }) {
  const clock = new FakeClock(100_000);
  const t0 = clock.now();
  const ambientPositionAt = (t: number) => opts.ambientPosAtT0 + (t - t0);

  const match: AcrMatch = {
    acrid: 'acr-1',
    title: 'Blinding Lights',
    artists: ['The Weeknd'],
    score: 100,
    durationMs: 200_040,
    playOffsetMs: 0, // filled per capture below
    spotifyTrackId: 'abc',
    spotifyUri: 'spotify:track:abc',
    raw: { acrid: 'acr-1', title: 'Blinding Lights' },
  };

  // Spotify device state
  let playbackStartedAt: number | null = null;
  let playbackStartPosition = 0;
  let playing = false;
  const playerPositionAt = (t: number) => (playbackStartedAt === null || t < playbackStartedAt ? null : playbackStartPosition + (t - playbackStartedAt));

  const playCalls: PlayReceipt[] = [];
  const seekCalls: number[] = [];
  const saved: StartupLatencyModel[] = [];
  const events: SyncEvent[] = [];

  const deps: SyncDeps = {
    clock,
    sleep: async (ms) => {
      clock.advance(ms);
    },
    capture: async (durationMs) => {
      const captureStart = clock.now() + 60; // encoder spin-up
      clock.advance(60 + durationMs);
      const captureEnd = clock.now();
      clock.advance(30); // file finalisation
      const sample: CapturedSample = {
        uri: `mem://${captureEnd}`,
        fileName: 'sample.m4a',
        mimeType: 'audio/mp4',
        sizeBytes: 40_000,
        recordedMs: durationMs,
        timings: { captureStart, captureEnd },
      };
      return sample;
    },
    signer: async (): Promise<AcrSignedFields> => ({ access_key: 'AK', data_type: 'audio', signature_version: '1', signature: 'S', timestamp: '1' }),
    identify: async (sample): Promise<IdentifyResult> => {
      const uploadStart = clock.now();
      clock.advance(opts.identifyRoundTripMs ?? 900);
      // ACRCloud reports the ambient position at the END of the sample (plus paired offsets).
      const captureMs = sample.timings.captureEnd - sample.timings.captureStart;
      const ambientAtEnd = ambientPositionAt(sample.timings.captureEnd);
      return {
        httpStatus: 200,
        timings: { uploadStart, responseReceived: clock.now() },
        outcome: {
          kind: 'match',
          costTimeMs: 400,
          alternatives: [],
          match: { ...match, playOffsetMs: ambientAtEnd, sampleEndOffsetMs: captureMs - 200, dbEndOffsetMs: ambientAtEnd - 200 },
        },
      };
    },
    spotify: {
      play: async (cmd) => {
        const dispatchAt = clock.now();
        playbackStartedAt = dispatchAt + opts.trueStartupLatencyMs;
        playbackStartPosition = cmd.positionMs;
        playing = true;
        clock.advance(120); // HTTP ack
        const receipt = { dispatchAt, ackAt: clock.now(), uri: cmd.uri, positionMs: cmd.positionMs };
        playCalls.push(receipt);
        return receipt;
      },
      seek: async (positionMs) => {
        const dispatchAt = clock.now();
        seekCalls.push(positionMs);
        // A seek lands after ~60% of the startup latency; the requested position applies at that instant.
        playbackStartedAt = dispatchAt + Math.round(opts.trueStartupLatencyMs * 0.6);
        playbackStartPosition = positionMs;
        clock.advance(100);
        return { dispatchAt, ackAt: clock.now() };
      },
      getPlaybackState: async (): Promise<TimedPlaybackState> => {
        const dispatchAt = clock.now();
        clock.advance(80);
        const sampledAt = dispatchAt + 40; // server sampled progress mid-request
        const progress = playerPositionAt(sampledAt);
        const state: SpotifyPlaybackState | null =
          playing && progress !== null
            ? ({ is_playing: true, progress_ms: Math.round(progress), item: { uri: 'spotify:track:abc' } } as unknown as SpotifyPlaybackState)
            : null;
        return { dispatchAt, ackAt: clock.now(), state };
      },
      findTrack: vi.fn(async () => null),
    },
    loadCalibration: async () => (opts.initialModel === undefined ? null : opts.initialModel),
    saveCalibration: async (model) => {
      saved.push(model);
    },
  };

  return { clock, deps, match, playCalls, seekCalls, saved, events, ambientPositionAt, playerPositionAt };
}

describe('SyncSession end-to-end', () => {
  it('sends position_ms = ambient position at capture end + elapsed + calibrated startup latency', async () => {
    const world = makeWorld({ trueStartupLatencyMs: 350, ambientPosAtT0: 60_000, initialModel: { estimateMs: 350, samples: 3 } });
    const session = new SyncSession(world.deps, { ...DEFAULT_SYNC_OPTIONS, verify: false }, (e) => world.events.push(e));
    const result = await session.run();

    expect(result.status).toBe('synced');
    if (result.status !== 'synced') return;

    const play = world.playCalls[0];
    const ambientAtCaptureEnd = result.target.referencePositionAtCaptureEndMs;

    // Expected: ambient(captureEnd) + (dispatchAt − captureEnd) + 350
    const expected = ambientAtCaptureEnd + result.target.breakdown.elapsedSinceCaptureEndMs + 350;
    expect(play.positionMs).toBe(Math.round(expected));
    expect(result.target.breakdown.anchorUsed).toBe('db_offsets');

    // Because the device's true latency equals the estimate, playback is exactly in unison.
    const audibleAt = play.dispatchAt + 350;
    expect(world.playerPositionAt(audibleAt)).toBeCloseTo(world.ambientPositionAt(audibleAt), 5);

    // Breakdown adds up: 6 s capture, 30 ms prep, 900 ms round trip.
    expect(result.target.breakdown.captureMs).toBe(6000);
    expect(result.target.breakdown.encodeAndPrepareMs).toBe(30);
    expect(result.target.breakdown.networkRoundTripMs).toBe(900);
    expect(result.target.breakdown.acrProcessingMs).toBe(400);
    expect(result.target.breakdown.totalCompensationMs).toBe(result.target.breakdown.elapsedSinceCaptureEndMs + 350);
  });

  it('measures the real startup latency from playback probes and persists the calibration', async () => {
    const world = makeWorld({ trueStartupLatencyMs: 800, ambientPosAtT0: 30_000 }); // no stored model → default 350
    const session = new SyncSession(world.deps, { ...DEFAULT_SYNC_OPTIONS, verify: false });
    const result = await session.run();

    expect(result.status).toBe('synced');
    if (result.status !== 'synced') return;
    expect(result.calibration.before.estimateMs).toBe(350);
    expect(result.calibration.measuredMs).toBe(800);
    expect(result.calibration.after).toMatchObject({ estimateMs: 800, samples: 1 });
    expect(world.saved.at(-1)).toMatchObject({ estimateMs: 800, samples: 1 });
  });

  it('detects residual drift on the verification pass and seeks to correct it', async () => {
    // Estimate says 350 ms but the device really takes 950 ms → we start 600 ms behind the room.
    // (samples: 0 = an untrained model, so the first probe measurement replaces the estimate outright.)
    const world = makeWorld({ trueStartupLatencyMs: 950, ambientPosAtT0: 45_000, initialModel: { estimateMs: 350, samples: 0 } });
    const session = new SyncSession(world.deps, { ...DEFAULT_SYNC_OPTIONS, verify: true }, (e) => world.events.push(e));
    const result = await session.run();

    expect(result.status).toBe('synced');
    if (result.status !== 'synced') return;

    // First pass: player is behind by (950 − 350) = 600 ms; the calibration probe measured the truth.
    expect(result.calibration.measuredMs).toBe(950);

    // Verification: drift ≈ +600 ms → a single forward seek.
    expect(result.verification?.sameTrack).toBe(true);
    expect(result.verification?.decision.action).toBe('seek');
    expect(result.verification?.decision.driftMs).toBeGreaterThan(500);
    expect(result.verification?.decision.driftMs).toBeLessThan(700);
    expect(world.seekCalls).toHaveLength(1);

    // After the seek lands, player and room agree to within a few ms.
    const t = world.clock.now() + 5000;
    const playerPos = world.playerPositionAt(t);
    expect(playerPos).not.toBeNull();
    expect(Math.abs((playerPos ?? 0) - world.ambientPositionAt(t))).toBeLessThan(25);

    // The drift feedback is a second measurement of the same 950 ms truth, so the model stays there.
    expect(result.calibration.after.estimateMs).toBeGreaterThan(900);
    expect(result.calibration.after.estimateMs).toBeLessThan(1000);

    expect(world.events.map((e) => e.phase)).toEqual(
      expect.arrayContaining(['listening', 'identifying', 'resolving', 'starting', 'calibrating', 'verifying', 'correcting', 'synced']),
    );
  });

  it('returns no_match without touching Spotify', async () => {
    const world = makeWorld({ trueStartupLatencyMs: 300, ambientPosAtT0: 0 });
    world.deps.identify = async () => ({ httpStatus: 200, timings: { uploadStart: 0, responseReceived: 1 }, outcome: { kind: 'no_match', costTimeMs: 300 } });
    const result = await new SyncSession(world.deps, { ...DEFAULT_SYNC_OPTIONS, verify: false }).run();
    expect(result).toEqual({ status: 'no_match', costTimeMs: 300 });
    expect(world.playCalls).toHaveLength(0);
  });

  it('refuses to start when the computed position is past the end of the track', async () => {
    const world = makeWorld({ trueStartupLatencyMs: 300, ambientPosAtT0: 199_000 });
    const result = await new SyncSession(world.deps, { ...DEFAULT_SYNC_OPTIONS, verify: false }).run();
    expect(result.status).toBe('track_ending');
    expect(world.playCalls).toHaveLength(0);
  });

  it('falls back to Spotify search when ACRCloud has no Spotify id', async () => {
    const world = makeWorld({ trueStartupLatencyMs: 300, ambientPosAtT0: 10_000 });
    const original = world.deps.identify;
    world.deps.identify = async (sample, signed) => {
      const r = await original(sample, signed);
      if (r.outcome.kind === 'match') r.outcome.match = { ...r.outcome.match, spotifyTrackId: undefined, spotifyUri: undefined, isrc: 'USUG11904206' };
      return r;
    };
    world.deps.spotify.findTrack = vi.fn(async () => ({ uri: 'spotify:track:found', name: 'Found', duration_ms: 200_040, artists: [{ id: 'a', name: 'Artist' }], id: 'found', album: { id: 'al', name: 'Album' } }));
    const result = await new SyncSession(world.deps, { ...DEFAULT_SYNC_OPTIONS, verify: false }).run();
    expect(result.status).toBe('synced');
    expect(world.deps.spotify.findTrack).toHaveBeenCalledWith({ isrc: 'USUG11904206', title: 'Blinding Lights', artists: ['The Weeknd'] });
    expect(world.playCalls[0].uri).toBe('spotify:track:found');
  });

  it('with a well-trained model, residual error after one correction is bounded by the EMA lag', async () => {
    const world = makeWorld({ trueStartupLatencyMs: 950, ambientPosAtT0: 45_000, initialModel: { estimateMs: 350, samples: 5 } });
    const result = await new SyncSession(world.deps, { ...DEFAULT_SYNC_OPTIONS, verify: true }).run();
    expect(result.status).toBe('synced');
    if (result.status !== 'synced') return;
    // Probe (950) then drift feedback (350 + 600) both pull the 350 ms estimate toward 950 at alpha 0.35.
    expect(result.calibration.after.estimateMs).toBeGreaterThan(600);
    expect(result.calibration.after.estimateMs).toBeLessThan(950);
    const t = world.clock.now() + 5000;
    // Seek used 60% of the *smoothed* estimate, so a residual of a couple hundred ms can remain; the next sync closes it.
    expect(Math.abs((world.playerPositionAt(t) ?? 0) - world.ambientPositionAt(t))).toBeLessThan(300);
  });

  it('creates a fresh default model when nothing is stored', () => {
    expect(createStartupLatencyModel().samples).toBe(0);
  });
});
