/**
 * Shapes returned by ACRCloud's Identification API (POST https://{host}/v1/identify).
 * Only the fields this app relies on are typed; everything else is preserved in `raw`.
 */

export interface AcrStatus {
  /** 0 = success. See ACR_STATUS_MESSAGES for the codes we handle explicitly. */
  code: number;
  msg: string;
  version: string;
}

export interface AcrArtist {
  name: string;
}

export interface AcrAlbum {
  name: string;
}

export interface AcrExternalIds {
  isrc?: string;
  upc?: string;
}

export interface AcrSpotifyMetadata {
  track?: { id: string; name?: string };
  album?: { id: string; name?: string };
  artists?: { id: string; name?: string }[];
}

export interface AcrExternalMetadata {
  spotify?: AcrSpotifyMetadata;
  deezer?: { track?: { id: string | number } };
  youtube?: { vid: string };
  [provider: string]: unknown;
}

export interface AcrMusic {
  acrid: string;
  title: string;
  artists?: AcrArtist[];
  album?: AcrAlbum;
  label?: string;
  release_date?: string;
  /** Total length of the reference recording in ACRCloud's database. */
  duration_ms?: number;
  /**
   * "Position of the recognition in the file if the file was playing (ms)". In practice this is
   * the reference-track position that lines up with the END of the matched portion of the sample.
   * See docs/BLUEPRINT.md § Offset anchoring.
   */
  play_offset_ms?: number;
  /** 0-100 confidence. */
  score?: number;
  /** Where inside OUR sample the match starts/ends (ms from the start of the uploaded file). */
  sample_begin_time_offset_ms?: number;
  sample_end_time_offset_ms?: number;
  /** Where inside the REFERENCE track the matched region starts/ends. */
  db_begin_time_offset_ms?: number;
  db_end_time_offset_ms?: number;
  external_ids?: AcrExternalIds;
  external_metadata?: AcrExternalMetadata;
}

export interface AcrIdentifyResponse {
  status: AcrStatus;
  /** ACRCloud server-side processing time, in SECONDS (float). */
  cost_time?: number;
  result_type?: number;
  metadata?: {
    timestamp_utc?: string;
    music?: AcrMusic[];
    humming?: AcrMusic[];
    custom_files?: unknown[];
  };
}

/** Subset of ACRCloud status codes worth surfacing to the user with a specific message. */
export const ACR_STATUS_MESSAGES: Record<number, string> = {
  0: 'Success',
  1001: 'No result',
  2000: 'Recording error (audio too short or silent)',
  2004: 'Unable to generate fingerprint (audio too short, silent, or unsupported format)',
  2005: 'Timeout',
  3000: 'Recognition service error (HTTP)',
  3001: 'Missing or invalid access key',
  3002: 'Invalid content type',
  3003: 'Request limit exceeded for this project',
  3006: 'Invalid arguments',
  3014: 'Invalid signature',
  3015: 'Could not generate fingerprint',
};

/** Normalised, sync-ready view of one ACRCloud music result. */
export interface AcrMatch {
  acrid: string;
  title: string;
  artists: string[];
  album?: string;
  score: number;
  durationMs?: number;
  playOffsetMs: number;
  sampleBeginOffsetMs?: number;
  sampleEndOffsetMs?: number;
  dbBeginOffsetMs?: number;
  dbEndOffsetMs?: number;
  isrc?: string;
  spotifyTrackId?: string;
  spotifyUri?: string;
  releaseDate?: string;
  raw: AcrMusic;
}

export type AcrIdentifyOutcome =
  | { kind: 'match'; match: AcrMatch; alternatives: AcrMatch[]; costTimeMs?: number }
  | { kind: 'no_match'; costTimeMs?: number }
  | { kind: 'error'; code: number; message: string };
