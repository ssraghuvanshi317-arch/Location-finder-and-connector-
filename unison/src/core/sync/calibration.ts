/**
 * Startup-latency calibration.
 *
 * `position_ms` is applied when the Spotify device *starts* playing, but the device only starts some
 * hundreds of milliseconds after we dispatch the HTTP request (Spotify Connect fan-out, buffering,
 * audio-session start). That gap is device- and network-specific, so we measure it and keep an
 * exponential moving average per device.
 */

export interface StartupLatencyModel {
  /** Current best estimate, ms. */
  estimateMs: number;
  /** Number of measurements folded into the estimate. 0 means "still the default". */
  samples: number;
  lastMeasuredMs?: number;
  updatedAtWall?: number;
}

/** Conservative first guess for a phone driving Spotify Connect over Wi-Fi/LTE. */
export const DEFAULT_STARTUP_LATENCY_MS = 350;
export const STARTUP_LATENCY_BOUNDS = { minMs: 0, maxMs: 4000 } as const;
export const DEFAULT_EMA_ALPHA = 0.35;

export function createStartupLatencyModel(initialMs = DEFAULT_STARTUP_LATENCY_MS): StartupLatencyModel {
  return { estimateMs: initialMs, samples: 0 };
}

export function clampStartupLatency(ms: number): number {
  return Math.min(STARTUP_LATENCY_BOUNDS.maxMs, Math.max(STARTUP_LATENCY_BOUNDS.minMs, ms));
}

/** Fold one measurement into the model. The first real measurement replaces the default outright. */
export function updateStartupLatency(
  model: StartupLatencyModel,
  measuredMs: number,
  alpha = DEFAULT_EMA_ALPHA,
  nowWall?: number,
): StartupLatencyModel {
  const clamped = clampStartupLatency(measuredMs);
  const estimateMs = model.samples === 0 ? clamped : clampStartupLatency(alpha * clamped + (1 - alpha) * model.estimateMs);
  return {
    estimateMs: Math.round(estimateMs),
    samples: model.samples + 1,
    lastMeasuredMs: Math.round(clamped),
    updatedAtWall: nowWall,
  };
}

export interface PlaybackProbe {
  /** `progress_ms` from GET /v1/me/player. */
  progressMs: number;
  /** Monotonic ms when the probe request was sent / when its response arrived. */
  requestSentAt: number;
  responseReceivedAt: number;
}

/** Best guess of the instant (monotonic ms) at which the probe's `progress_ms` was sampled. */
export function probeMidpoint(probe: PlaybackProbe): number {
  return probe.requestSentAt + (probe.responseReceivedAt - probe.requestSentAt) / 2;
}

export interface StartupMeasurementInput {
  /** The position_ms we asked Spotify to start at. */
  requestedPositionMs: number;
  /** Monotonic ms when the play request was dispatched. */
  dispatchAt: number;
  probe: PlaybackProbe;
}

/**
 * We asked for position P at time `dispatchAt`. A probe at midpoint M reports progress p. Audio must
 * therefore have started at M - (p - P), so startup latency = M - (p - P) - dispatchAt.
 *
 * Returns null when the probe is implausible (progress before the requested position means the track
 * hasn't started yet or a different item is playing).
 */
export function measureStartupLatency(input: StartupMeasurementInput): number | null {
  const { requestedPositionMs, dispatchAt, probe } = input;
  const played = probe.progressMs - requestedPositionMs;
  if (played < 0) return null;
  const startedAt = probeMidpoint(probe) - played;
  const latency = startedAt - dispatchAt;
  if (latency < -250 || latency > STARTUP_LATENCY_BOUNDS.maxMs * 2) return null;
  return Math.round(latency);
}
