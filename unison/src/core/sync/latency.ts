import type { AcrMatch } from '../acrcloud/types';

/**
 * Latency compensation — the heart of the app.
 *
 * Timeline (all readings from the same monotonic clock):
 *
 *   captureStart ──── captureEnd ──── uploadStart ──── responseReceived ──── dispatchAt ──── audible
 *        │  recording   │  encode/prep  │   upload + ACR + download   │  decide  │  startup   │
 *
 * ACRCloud tells us where the AMBIENT source was at `captureEnd` (see referencePositionAtCaptureEnd).
 * The ambient source keeps playing while we wait for the network, so by the time the Spotify device
 * actually produces sound we must be at:
 *
 *   position_ms = refPos(captureEnd)
 *               + (dispatchAt - captureEnd)     // everything that happened after the recording stopped
 *               + startupLatencyMs              // play command -> first audible sample (calibrated)
 *               + userTrimMs                    // manual nudge
 */

export type OffsetAnchor = 'sample_end' | 'sample_start';

export interface CaptureTimings {
  /** Monotonic ms when the first audio frame was captured. */
  captureStart: number;
  /** Monotonic ms when the last audio frame was captured (recorder.stop() resolved). */
  captureEnd: number;
  /** Monotonic ms when the HTTP request left the app. */
  uploadStart: number;
  /** Monotonic ms when the ACRCloud response body was received and parsed. */
  responseReceived: number;
}

export type OffsetSource = Pick<AcrMatch, 'playOffsetMs' | 'sampleEndOffsetMs' | 'dbEndOffsetMs' | 'durationMs'>;

export interface TargetPositionInput {
  match: OffsetSource;
  timings: CaptureTimings;
  /** Monotonic ms at which the play command is dispatched. Read the clock immediately before calling play(). */
  dispatchAt: number;
  /** Calibrated ms between dispatching the play command and audible output on the Spotify device. */
  startupLatencyMs: number;
  /** Manual trim, positive = play further ahead. */
  userTrimMs?: number;
  /** Which end of the sample `play_offset_ms` refers to. Ignored when db/sample end offsets are present. */
  anchor?: OffsetAnchor;
  /** ACRCloud's own processing time (from cost_time) — informational, already inside networkRoundTripMs. */
  acrProcessingMs?: number;
  /** Refuse to sync when fewer than this many ms remain in the track (default 1500). */
  minRemainingMs?: number;
}

export interface LatencyBreakdown {
  captureMs: number;
  encodeAndPrepareMs: number;
  networkRoundTripMs: number;
  acrProcessingMs?: number;
  decisionMs: number;
  /** dispatchAt - captureEnd: the wall time the ambient source advanced while we were busy. */
  elapsedSinceCaptureEndMs: number;
  startupLatencyMs: number;
  userTrimMs: number;
  /** Everything added on top of the reference position at captureEnd. */
  totalCompensationMs: number;
  anchorUsed: 'db_offsets' | OffsetAnchor;
}

export interface TargetPositionResult {
  /** The value to send as Spotify `position_ms`. Never negative. */
  positionMs: number;
  referencePositionAtCaptureEndMs: number;
  breakdown: LatencyBreakdown;
  /** True when the computed position lands at/after the end of the reference track. */
  trackWillHaveEnded: boolean;
  remainingMs?: number;
}

export const DEFAULT_OFFSET_ANCHOR: OffsetAnchor = 'sample_end';

/**
 * Where was the ambient source when our recording stopped?
 *
 * Preferred: ACRCloud's paired offsets. `sample_end_time_offset_ms` is a point inside our file and
 * `db_end_time_offset_ms` is the matching point in the reference track. The recording continued for
 * (captureMs - sampleEnd) after that point, so we extrapolate. This is immune to whichever end of the
 * sample `play_offset_ms` is anchored to.
 *
 * Fallback: `play_offset_ms` with an explicit anchor assumption (default: end of sample).
 */
export function referencePositionAtCaptureEnd(
  match: OffsetSource,
  captureMs: number,
  anchor: OffsetAnchor = DEFAULT_OFFSET_ANCHOR,
): { positionMs: number; anchorUsed: LatencyBreakdown['anchorUsed'] } {
  const { sampleEndOffsetMs, dbEndOffsetMs } = match;
  if (sampleEndOffsetMs !== undefined && dbEndOffsetMs !== undefined) {
    // Clamp the extrapolation so a bizarre response can't throw us more than the sample length away.
    const tail = Math.min(Math.max(captureMs - sampleEndOffsetMs, -1000), captureMs);
    return { positionMs: dbEndOffsetMs + tail, anchorUsed: 'db_offsets' };
  }
  if (anchor === 'sample_start') {
    return { positionMs: match.playOffsetMs + captureMs, anchorUsed: 'sample_start' };
  }
  return { positionMs: match.playOffsetMs, anchorUsed: 'sample_end' };
}

export function computeTargetPosition(input: TargetPositionInput): TargetPositionResult {
  const { timings, match } = input;
  const userTrimMs = input.userTrimMs ?? 0;
  const minRemainingMs = input.minRemainingMs ?? 1500;

  const captureMs = timings.captureEnd - timings.captureStart;
  const encodeAndPrepareMs = timings.uploadStart - timings.captureEnd;
  const networkRoundTripMs = timings.responseReceived - timings.uploadStart;
  const decisionMs = input.dispatchAt - timings.responseReceived;
  const elapsedSinceCaptureEndMs = input.dispatchAt - timings.captureEnd;

  const ref = referencePositionAtCaptureEnd(match, captureMs, input.anchor);
  const totalCompensationMs = elapsedSinceCaptureEndMs + input.startupLatencyMs + userTrimMs;
  const rawPosition = ref.positionMs + totalCompensationMs;
  const positionMs = Math.max(0, Math.round(rawPosition));

  const remainingMs = match.durationMs !== undefined ? match.durationMs - positionMs : undefined;
  const trackWillHaveEnded = remainingMs !== undefined && remainingMs < minRemainingMs;

  return {
    positionMs,
    referencePositionAtCaptureEndMs: ref.positionMs,
    trackWillHaveEnded,
    remainingMs,
    breakdown: {
      captureMs,
      encodeAndPrepareMs,
      networkRoundTripMs,
      acrProcessingMs: input.acrProcessingMs,
      decisionMs,
      elapsedSinceCaptureEndMs,
      startupLatencyMs: input.startupLatencyMs,
      userTrimMs,
      totalCompensationMs,
      anchorUsed: ref.anchorUsed,
    },
  };
}

/** Where the ambient source is *now*, given where it was at captureEnd. */
export function ambientPositionAt(referencePositionAtCaptureEndMs: number, captureEnd: number, at: number): number {
  return referencePositionAtCaptureEndMs + (at - captureEnd);
}
