import type { Clock } from '../clock';
import { systemClock } from '../clock';
import { SpotifyApiError, type SpotifyDevice, type SpotifyErrorReason, type SpotifyPlaybackState, type SpotifyTrack } from './types';

export interface SpotifyClientOptions {
  /** Returns a valid (refreshed if needed) access token. */
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  baseUrl?: string;
}

export interface PlayCommand {
  /** spotify:track:... */
  uri: string;
  /** Start position. Spotify starts the NEXT track if this exceeds the track length. */
  positionMs: number;
  /** Target device; omit to use the user's currently active device. */
  deviceId?: string;
}

export interface Timed {
  /** Monotonic ms when the request was dispatched. */
  dispatchAt: number;
  /** Monotonic ms when the response arrived. */
  ackAt: number;
}

export interface PlayReceipt extends Timed {
  uri: string;
  positionMs: number;
}

export interface TimedPlaybackState extends Timed {
  state: SpotifyPlaybackState | null;
}

type Query = Record<string, string | number | boolean | undefined>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Retry once after `Retry-After` on 429 (default true). */
  retryOnRateLimit?: boolean;
}

/**
 * Thin, dependency-free Spotify Web API client. Only the endpoints the sync pipeline needs.
 * All calls report dispatch/ack timestamps from the injected clock so callers can do latency math.
 */
export class SpotifyClient {
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly baseUrl: string;

  constructor(options: SpotifyClientOptions) {
    this.getAccessToken = options.getAccessToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? systemClock;
    this.baseUrl = (options.baseUrl ?? 'https://api.spotify.com/v1').replace(/\/+$/, '');
  }

  /** PUT /me/player/play — start `uri` at `positionMs`. Requires Spotify Premium. */
  async play(cmd: PlayCommand): Promise<PlayReceipt> {
    const positionMs = Math.max(0, Math.round(cmd.positionMs));
    const dispatchAt = this.clock.now();
    await this.request('PUT', '/me/player/play', {
      query: { device_id: cmd.deviceId },
      body: { uris: [cmd.uri], position_ms: positionMs },
    });
    return { dispatchAt, ackAt: this.clock.now(), uri: cmd.uri, positionMs };
  }

  /** PUT /me/player/seek — jump within the current track. */
  async seek(positionMs: number, deviceId?: string): Promise<Timed> {
    const dispatchAt = this.clock.now();
    await this.request('PUT', '/me/player/seek', {
      query: { position_ms: Math.max(0, Math.round(positionMs)), device_id: deviceId },
    });
    return { dispatchAt, ackAt: this.clock.now() };
  }

  async pause(deviceId?: string): Promise<Timed> {
    const dispatchAt = this.clock.now();
    await this.request('PUT', '/me/player/pause', { query: { device_id: deviceId } });
    return { dispatchAt, ackAt: this.clock.now() };
  }

  /** GET /me/player — null state when nothing is playing (HTTP 204). */
  async getPlaybackState(): Promise<TimedPlaybackState> {
    const dispatchAt = this.clock.now();
    const res = await this.request('GET', '/me/player', { query: { additional_types: 'track' } });
    const ackAt = this.clock.now();
    if (res.status === 204) return { dispatchAt, ackAt, state: null };
    const state = (await res.json()) as SpotifyPlaybackState;
    return { dispatchAt, ackAt, state };
  }

  async getDevices(): Promise<SpotifyDevice[]> {
    const res = await this.request('GET', '/me/player/devices');
    const json = (await res.json()) as { devices: SpotifyDevice[] };
    return json.devices ?? [];
  }

  /** PUT /me/player — move playback to a device (optionally starting playback there). */
  async transferPlayback(deviceId: string, play = false): Promise<void> {
    await this.request('PUT', '/me/player', { body: { device_ids: [deviceId], play } });
  }

  async getTrack(id: string): Promise<SpotifyTrack> {
    const res = await this.request('GET', `/tracks/${encodeURIComponent(id)}`);
    return (await res.json()) as SpotifyTrack;
  }

  /**
   * Resolve a track when ACRCloud did not hand us a Spotify id. ISRC is exact (same master recording,
   * so offsets line up); title + artist is the fuzzy fallback.
   */
  async findTrack(lookup: { isrc?: string; title?: string; artists?: string[] }): Promise<SpotifyTrack | null> {
    if (lookup.isrc) {
      const isrc = lookup.isrc.toUpperCase();
      const byIsrc = await this.search(`isrc:${isrc}`, 5);
      const exact = byIsrc.find((t) => t.external_ids?.isrc?.toUpperCase() === isrc);
      if (exact ?? byIsrc[0]) return exact ?? byIsrc[0] ?? null;
    }
    if (lookup.title) {
      const artist = lookup.artists?.[0];
      const q = artist ? `track:"${lookup.title}" artist:"${artist}"` : `track:"${lookup.title}"`;
      const results = await this.search(q, 5);
      return results[0] ?? null;
    }
    return null;
  }

  async search(q: string, limit = 5): Promise<SpotifyTrack[]> {
    const res = await this.request('GET', '/search', { query: { q, type: 'track', limit } });
    const json = (await res.json()) as { tracks?: { items?: SpotifyTrack[] } };
    return json.tracks?.items ?? [];
  }

  private async request(method: 'GET' | 'PUT' | 'POST', path: string, options: RequestOptions = {}): Promise<Response> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const token = await this.getAccessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const res = await this.fetchImpl(url.toString(), { method, headers, body });
    if (res.ok) return res;

    if (res.status === 429 && (options.retryOnRateLimit ?? true)) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? '1');
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 5) * 1000));
      return this.request(method, path, { ...options, retryOnRateLimit: false });
    }

    throw await toApiError(res);
  }
}

export async function toApiError(res: Response): Promise<SpotifyApiError> {
  let message = `Spotify API error ${res.status}`;
  let apiReason: string | undefined;
  try {
    const json = (await res.json()) as { error?: { message?: string; reason?: string } };
    message = json.error?.message ?? message;
    apiReason = json.error?.reason;
  } catch {
    // non-JSON body; keep the default message
  }

  let reason: SpotifyErrorReason = 'UNKNOWN';
  if (res.status === 401) reason = 'UNAUTHORIZED';
  else if (res.status === 429) reason = 'RATE_LIMITED';
  else if (apiReason === 'NO_ACTIVE_DEVICE') reason = 'NO_ACTIVE_DEVICE';
  else if (apiReason === 'PREMIUM_REQUIRED') reason = 'PREMIUM_REQUIRED';
  else if (res.status === 404) reason = 'NOT_FOUND';

  const retryAfter = res.headers.get('Retry-After');
  return new SpotifyApiError(message, res.status, reason, retryAfter ? Number(retryAfter) : undefined);
}

export function userFacingSpotifyMessage(error: unknown): string {
  if (!(error instanceof SpotifyApiError)) return error instanceof Error ? error.message : String(error);
  switch (error.reason) {
    case 'NO_ACTIVE_DEVICE':
      return 'No active Spotify device. Open Spotify on this phone (or any device) and press play once, then retry.';
    case 'PREMIUM_REQUIRED':
      return 'Controlling playback requires Spotify Premium.';
    case 'UNAUTHORIZED':
      return 'Spotify session expired. Please reconnect Spotify.';
    case 'RATE_LIMITED':
      return `Spotify rate limit hit. Try again in ${error.retryAfterSec ?? 1}s.`;
    default:
      return `Spotify error: ${error.message}`;
  }
}
