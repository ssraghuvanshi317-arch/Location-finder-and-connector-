/**
 * Drift correction — the second pass that turns "close" into "in unison".
 *
 * After playback starts we take a second, shorter recording and identify it again. That gives us the
 * ambient source's position at a known instant. We compare it with our own player's position at a
 * known instant and, if they disagree by more than a threshold, issue a single corrective seek.
 * Every correction is also fed back into the startup-latency model so the next sync starts closer.
 */

export interface TimedPosition {
  /** Track position in ms. */
  positionMs: number;
  /** Monotonic ms at which that position was true. */
  at: number;
}

export interface DriftInput {
  ambient: TimedPosition;
  player: TimedPosition;
  /** Monotonic ms "now" (when the seek would be dispatched). */
  nowMs: number;
  /** Intentional offset the listener wants relative to the room (the manual trim). Default 0. */
  targetOffsetMs?: number;
  /** Ignore drift smaller than this (default 120 ms — below most listeners' echo threshold). */
  thresholdMs?: number;
  /** How long a seek takes to become audible on the device; defaults to 60% of startup latency. */
  seekLatencyMs?: number;
  /** Refuse to correct if the two passes disagree by more than this — probably a different track (default 30 s). */
  maxPlausibleDriftMs?: number;
}

export interface DriftDecision {
  /** (ambient + targetOffset) - player, normalised to nowMs. Positive means our player is BEHIND where it should be. */
  driftMs: number;
  action: 'none' | 'seek' | 'resync';
  /** Present when action === 'seek'. */
  seekToMs?: number;
}

export const DEFAULT_DRIFT_THRESHOLD_MS = 120;
export const DEFAULT_MAX_PLAUSIBLE_DRIFT_MS = 30_000;

export function decideDriftCorrection(input: DriftInput): DriftDecision {
  const thresholdMs = input.thresholdMs ?? DEFAULT_DRIFT_THRESHOLD_MS;
  const maxPlausible = input.maxPlausibleDriftMs ?? DEFAULT_MAX_PLAUSIBLE_DRIFT_MS;
  const seekLatencyMs = input.seekLatencyMs ?? 0;
  const targetOffsetMs = input.targetOffsetMs ?? 0;

  const ambientNow = input.ambient.positionMs + (input.nowMs - input.ambient.at);
  const desiredNow = ambientNow + targetOffsetMs;
  const playerNow = input.player.positionMs + (input.nowMs - input.player.at);
  const driftMs = Math.round(desiredNow - playerNow);

  if (Math.abs(driftMs) > maxPlausible) return { driftMs, action: 'resync' };
  if (Math.abs(driftMs) <= thresholdMs) return { driftMs, action: 'none' };
  return { driftMs, action: 'seek', seekToMs: Math.max(0, Math.round(desiredNow + seekLatencyMs)) };
}
