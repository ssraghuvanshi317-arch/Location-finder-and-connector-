/** Minimal typings for the Spotify Web API objects this app touches. */

export interface SpotifyImage {
  url: string;
  width: number | null;
  height: number | null;
}

export interface SpotifyDevice {
  id: string | null;
  is_active: boolean;
  is_private_session: boolean;
  is_restricted: boolean;
  name: string;
  type: string;
  volume_percent: number | null;
  supports_volume?: boolean;
}

export interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  duration_ms: number;
  artists: { id: string; name: string }[];
  album: { id: string; name: string; images?: SpotifyImage[] };
  external_ids?: { isrc?: string; ean?: string; upc?: string };
  is_playable?: boolean;
}

export interface SpotifyPlaybackState {
  device: SpotifyDevice;
  repeat_state: 'off' | 'track' | 'context';
  shuffle_state: boolean;
  /** Unix ms when the playback state was last changed, as reported by Spotify. */
  timestamp: number;
  progress_ms: number | null;
  is_playing: boolean;
  item: SpotifyTrack | null;
  currently_playing_type: 'track' | 'episode' | 'ad' | 'unknown';
}

export type SpotifyErrorReason =
  | 'NO_ACTIVE_DEVICE'
  | 'PREMIUM_REQUIRED'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'UNKNOWN';

export class SpotifyApiError extends Error {
  readonly status: number;
  readonly reason: SpotifyErrorReason;
  readonly retryAfterSec?: number;

  constructor(message: string, status: number, reason: SpotifyErrorReason, retryAfterSec?: number) {
    super(message);
    this.name = 'SpotifyApiError';
    this.status = status;
    this.reason = reason;
    this.retryAfterSec = retryAfterSec;
  }
}

export const SPOTIFY_SCOPES = [
  'user-modify-playback-state', // PUT /me/player/play, /seek, /pause, transfer
  'user-read-playback-state', // GET /me/player, /me/player/devices
  'user-read-currently-playing',
] as const;
