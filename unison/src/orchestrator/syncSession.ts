import type { IdentifyResult } from '../core/acrcloud/identify';
import { describeMatch } from '../core/acrcloud/parse';
import type { AcrSignedFields, AcrSigner } from '../core/acrcloud/signing';
import type { AcrMatch } from '../core/acrcloud/types';
import type { Clock } from '../core/clock';
import type { CapturedSample } from '../core/sample';
import type { PlayReceipt, SpotifyClient } from '../core/spotify/client';
import {
  createStartupLatencyModel,
  measureStartupLatency,
  probeMidpoint,
  updateStartupLatency,
  type StartupLatencyModel,
} from '../core/sync/calibration';
import { decideDriftCorrection, type DriftDecision } from '../core/sync/drift';
import {
  computeTargetPosition,
  referencePositionAtCaptureEnd,
  type CaptureTimings,
  type OffsetAnchor,
  type TargetPositionResult,
} from '../core/sync/latency';

/**
 * The end-to-end pipeline:
 *
 *   listen → identify → resolve Spotify track → compute position → play → calibrate → verify/correct
 *
 * Everything platform-specific (microphone, storage, auth) is injected through `SyncDeps`, so this
 * file is pure TypeScript and is exercised end-to-end in Node by `syncSession.test.ts`.
 */

export type SyncPhase =
  | 'idle'
  | 'listening'
  | 'identifying'
  | 'resolving'
  | 'starting'
  | 'calibrating'
  | 'verifying'
  | 'correcting'
  | 'synced'
  | 'no_match'
  | 'error';

export interface SyncEvent {
  phase: SyncPhase;
  message: string;
  /** Monotonic ms. */
  at: number;
}

export type SpotifyPort = Pick<SpotifyClient, 'play' | 'seek' | 'getPlaybackState' | 'findTrack'>;

export interface SyncDeps {
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  capture: (durationMs: number) => Promise<CapturedSample>;
  signer: AcrSigner;
  identify: (sample: CapturedSample, signedFields: Promise<AcrSignedFields>) => Promise<IdentifyResult>;
  spotify: SpotifyPort;
  loadCalibration: () => Promise<StartupLatencyModel | null>;
  saveCalibration: (model: StartupLatencyModel) => Promise<void>;
}

export interface SyncOptions {
  /** Length of the first recording. ACRCloud recommends ≥ 3 s; 6 s is a good speed/accuracy trade-off. */
  captureMs: number;
  /** Run the second-pass drift check. Turn OFF when Spotify plays through this phone's speaker. */
  verify: boolean;
  verifyCaptureMs: number;
  /** How long to let playback settle before the verification recording. */
  verifyDelayMs: number;
  probeAttempts: number;
  probeIntervalMs: number;
  minScore: number;
  driftThresholdMs: number;
  anchor: OffsetAnchor;
  userTrimMs: number;
  deviceId?: string;
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  captureMs: 6000,
  verify: true,
  verifyCaptureMs: 5000,
  verifyDelayMs: 3000,
  probeAttempts: 6,
  probeIntervalMs: 300,
  minScore: 60,
  driftThresholdMs: 120,
  anchor: 'sample_end',
  userTrimMs: 0,
};

export interface SyncVerification {
  sameTrack: boolean;
  ambientPositionMs: number;
  playerPositionMs: number;
  decision: DriftDecision;
  seekedToMs?: number;
}

export interface SyncSuccess {
  status: 'synced';
  match: AcrMatch;
  uri: string;
  trackLabel: string;
  target: TargetPositionResult;
  play: PlayReceipt;
  calibration: { before: StartupLatencyModel; measuredMs: number | null; after: StartupLatencyModel };
  verification?: SyncVerification;
}

export type SyncResult =
  | SyncSuccess
  | { status: 'no_match'; costTimeMs?: number }
  | { status: 'no_spotify_track'; match: AcrMatch }
  | { status: 'track_ending'; match: AcrMatch; target: TargetPositionResult }
  | { status: 'aborted' };

export class SyncSession {
  private aborted = false;

  constructor(
    private readonly deps: SyncDeps,
    private readonly options: SyncOptions = DEFAULT_SYNC_OPTIONS,
    private readonly onEvent: (event: SyncEvent) => void = () => {},
  ) {}

  abort(): void {
    this.aborted = true;
  }

  private emit(phase: SyncPhase, message: string): void {
    this.onEvent({ phase, message, at: this.deps.clock.now() });
  }

  async run(): Promise<SyncResult> {
    const { clock, deps, options } = { clock: this.deps.clock, deps: this.deps, options: this.options };

    // Kick off work that does not depend on the recording so it overlaps with the capture window.
    const calibrationPromise = deps.loadCalibration().catch(() => null);
    const signedFields = deps.signer();
    signedFields.catch(() => undefined); // surfaced later, inside identify()

    this.emit('listening', `Listening for ${(options.captureMs / 1000).toFixed(1)} s…`);
    const sample = await deps.capture(options.captureMs);
    if (this.aborted) return { status: 'aborted' };

    this.emit('identifying', `Uploading ${(sample.sizeBytes / 1024).toFixed(0)} KB to ACRCloud…`);
    const identified = await deps.identify(sample, signedFields);
    if (this.aborted) return { status: 'aborted' };

    if (identified.outcome.kind === 'error') {
      throw new Error(`ACRCloud: ${identified.outcome.message} (code ${identified.outcome.code})`);
    }
    if (identified.outcome.kind === 'no_match') {
      this.emit('no_match', 'No match. Get closer to the speaker and try again.');
      return { status: 'no_match', costTimeMs: identified.outcome.costTimeMs };
    }

    const match = identified.outcome.match;
    this.emit('resolving', `Matched “${describeMatch(match)}” (score ${match.score})`);

    // Resolve the Spotify URI. ACRCloud usually includes it; otherwise fall back to ISRC/title search.
    let uri = match.spotifyUri;
    let trackLabel = describeMatch(match);
    let durationMs = match.durationMs;
    if (!uri) {
      const track = await deps.spotify.findTrack({ isrc: match.isrc, title: match.title, artists: match.artists });
      if (!track) {
        this.emit('error', 'Song identified but not found on Spotify.');
        return { status: 'no_spotify_track', match };
      }
      uri = track.uri;
      trackLabel = `${track.name} — ${track.artists.map((a) => a.name).join(', ')}`;
      durationMs = track.duration_ms;
      if (match.durationMs !== undefined && Math.abs(match.durationMs - track.duration_ms) > 2000) {
        this.emit('resolving', 'Warning: Spotify version differs in length from the recognised master; sync may be off.');
      }
    }

    const before = (await calibrationPromise) ?? createStartupLatencyModel();
    const timings: CaptureTimings = {
      captureStart: sample.timings.captureStart,
      captureEnd: sample.timings.captureEnd,
      uploadStart: identified.timings.uploadStart,
      responseReceived: identified.timings.responseReceived,
    };

    // Read the clock immediately before dispatching so decisionMs is real, then send.
    const dispatchAt = clock.now();
    const target = computeTargetPosition({
      match: { ...match, durationMs },
      timings,
      dispatchAt,
      startupLatencyMs: before.estimateMs,
      userTrimMs: options.userTrimMs,
      anchor: options.anchor,
      acrProcessingMs: identified.outcome.costTimeMs,
    });
    if (target.trackWillHaveEnded) {
      this.emit('error', 'The song is about to end; nothing to sync to.');
      return { status: 'track_ending', match, target };
    }

    this.emit(
      'starting',
      `Starting Spotify at ${formatMs(target.positionMs)} (ambient was at ${formatMs(target.referencePositionAtCaptureEndMs)} when recording stopped; +${target.breakdown.totalCompensationMs} ms compensation)`,
    );
    const play = await deps.spotify.play({ uri, positionMs: target.positionMs, deviceId: options.deviceId });

    this.emit('calibrating', 'Measuring how long the device took to start…');
    const measuredMs = await this.probeStartupLatency(uri, play);
    let model = before;
    if (measuredMs !== null) {
      model = updateStartupLatency(before, measuredMs, undefined, clock.wallNow());
      await deps.saveCalibration(model).catch(() => undefined);
      this.emit('calibrating', `Startup latency measured ${measuredMs} ms → estimate now ${model.estimateMs} ms`);
    } else {
      this.emit('calibrating', 'Could not measure startup latency this time (device did not report playback in time).');
    }

    let verification: SyncVerification | undefined;
    if (options.verify && !this.aborted) {
      verification = await this.verifyAndCorrect(match, uri, model);
      if (verification && (verification.decision.action === 'seek' || verification.decision.action === 'none')) {
        // The play command used `before.estimateMs`. The drift we just heard is exactly the error in that
        // estimate (drift = trueStartup − estimate), so `before + drift` is a direct, audio-based measurement
        // of the device's startup latency — more trustworthy than the probe, which relies on Spotify's
        // reported progress. Fold it in as one more sample.
        model = updateStartupLatency(model, before.estimateMs + verification.decision.driftMs, undefined, clock.wallNow());
        await deps.saveCalibration(model).catch(() => undefined);
      }
    }

    this.emit('synced', verification ? `In sync (residual drift ${verification.decision.driftMs} ms).` : 'Playing in sync.');
    return {
      status: 'synced',
      match,
      uri,
      trackLabel,
      target,
      play,
      calibration: { before, measuredMs, after: model },
      verification,
    };
  }

  /** Poll GET /me/player until the device reports our track, then derive startup latency. */
  private async probeStartupLatency(uri: string, play: PlayReceipt): Promise<number | null> {
    for (let attempt = 0; attempt < this.options.probeAttempts && !this.aborted; attempt++) {
      await this.deps.sleep(this.options.probeIntervalMs);
      const probe = await this.deps.spotify.getPlaybackState();
      const state = probe.state;
      if (!state || !state.is_playing || state.item?.uri !== uri || state.progress_ms === null) continue;
      const measured = measureStartupLatency({
        requestedPositionMs: play.positionMs,
        dispatchAt: play.dispatchAt,
        probe: { progressMs: state.progress_ms, requestSentAt: probe.dispatchAt, responseReceivedAt: probe.ackAt },
      });
      if (measured !== null) return measured;
    }
    return null;
  }

  /** Second recognition pass: compare the room with our player and seek once if they disagree. */
  private async verifyAndCorrect(match: AcrMatch, uri: string, model: StartupLatencyModel): Promise<SyncVerification | undefined> {
    const { deps, options } = this;
    this.emit('verifying', 'Listening again to check the sync…');
    await deps.sleep(options.verifyDelayMs);
    if (this.aborted) return undefined;

    const signedFields = deps.signer();
    signedFields.catch(() => undefined);
    const sample = await deps.capture(options.verifyCaptureMs);
    // Probe the player the instant the recording stops so both readings share a time base.
    const [identified, probe] = await Promise.all([deps.identify(sample, signedFields), deps.spotify.getPlaybackState()]);

    if (identified.outcome.kind !== 'match') {
      this.emit('verifying', 'Verification inconclusive (second recognition failed). Keeping the first sync.');
      return undefined;
    }
    const state = probe.state;
    if (!state || state.progress_ms === null || state.item?.uri !== uri) {
      this.emit('verifying', 'Verification inconclusive (player state unavailable).');
      return undefined;
    }

    const second = identified.outcome.match;
    const sameTrack = second.acrid === match.acrid || (!!second.spotifyTrackId && second.spotifyTrackId === match.spotifyTrackId);
    const captureMs = sample.timings.captureEnd - sample.timings.captureStart;
    const ambientPositionMs = referencePositionAtCaptureEnd(second, captureMs, options.anchor).positionMs;
    const playerAt = probeMidpoint({ progressMs: state.progress_ms, requestSentAt: probe.dispatchAt, responseReceivedAt: probe.ackAt });

    const decision = sameTrack
      ? decideDriftCorrection({
          ambient: { positionMs: ambientPositionMs, at: sample.timings.captureEnd },
          player: { positionMs: state.progress_ms, at: playerAt },
          nowMs: deps.clock.now(),
          thresholdMs: options.driftThresholdMs,
          targetOffsetMs: options.userTrimMs,
          seekLatencyMs: Math.round(model.estimateMs * 0.6),
        })
      : { driftMs: 0, action: 'resync' as const };

    let seekedToMs: number | undefined;
    if (decision.action === 'seek' && decision.seekToMs !== undefined) {
      this.emit('correcting', `Drift ${decision.driftMs > 0 ? '+' : ''}${decision.driftMs} ms — seeking to ${formatMs(decision.seekToMs)}`);
      await deps.spotify.seek(decision.seekToMs, options.deviceId);
      seekedToMs = decision.seekToMs;
    } else if (decision.action === 'resync') {
      this.emit('verifying', sameTrack ? 'Drift too large to trust; run a fresh sync.' : 'The room moved on to a different song; run a fresh sync.');
    } else {
      this.emit('verifying', `Within tolerance (drift ${decision.driftMs} ms).`);
    }

    return { sameTrack, ambientPositionMs, playerPositionMs: state.progress_ms, decision, seekedToMs };
  }
}

export function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}
