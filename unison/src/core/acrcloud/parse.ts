import { ACR_STATUS_MESSAGES, type AcrIdentifyOutcome, type AcrIdentifyResponse, type AcrMatch, type AcrMusic } from './types';

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function toMatch(music: AcrMusic): AcrMatch | null {
  if (!isNumber(music.play_offset_ms)) return null; // cannot sync without a position

  const spotifyTrackId = music.external_metadata?.spotify?.track?.id;
  return {
    acrid: music.acrid,
    title: music.title,
    artists: (music.artists ?? []).map((a) => a.name).filter(Boolean),
    album: music.album?.name,
    score: isNumber(music.score) ? music.score : 0,
    durationMs: isNumber(music.duration_ms) ? music.duration_ms : undefined,
    playOffsetMs: music.play_offset_ms,
    sampleBeginOffsetMs: isNumber(music.sample_begin_time_offset_ms) ? music.sample_begin_time_offset_ms : undefined,
    sampleEndOffsetMs: isNumber(music.sample_end_time_offset_ms) ? music.sample_end_time_offset_ms : undefined,
    dbBeginOffsetMs: isNumber(music.db_begin_time_offset_ms) ? music.db_begin_time_offset_ms : undefined,
    dbEndOffsetMs: isNumber(music.db_end_time_offset_ms) ? music.db_end_time_offset_ms : undefined,
    isrc: music.external_ids?.isrc,
    spotifyTrackId,
    spotifyUri: spotifyTrackId ? `spotify:track:${spotifyTrackId}` : undefined,
    releaseDate: music.release_date,
    raw: music,
  };
}

/**
 * Turn a raw identify response into a sync-ready outcome. Results are ranked by score and only
 * entries that carry a play offset are eligible.
 */
export function parseIdentifyResponse(json: unknown, minScore = 0): AcrIdentifyOutcome {
  const body = json as Partial<AcrIdentifyResponse> | null;
  const code = body?.status?.code;
  if (!body || !isNumber(code)) {
    return { kind: 'error', code: -1, message: 'Malformed ACRCloud response' };
  }

  const costTimeMs = isNumber(body.cost_time) ? Math.round(body.cost_time * 1000) : undefined;

  if (code === 1001) return { kind: 'no_match', costTimeMs };
  if (code !== 0) {
    return { kind: 'error', code, message: ACR_STATUS_MESSAGES[code] ?? body.status?.msg ?? `ACRCloud error ${code}` };
  }

  const ranked = (body.metadata?.music ?? [])
    .map(toMatch)
    .filter((m): m is AcrMatch => m !== null && m.score >= minScore)
    .sort((a, b) => b.score - a.score);

  const [best, ...alternatives] = ranked;
  if (!best) return { kind: 'no_match', costTimeMs };
  return { kind: 'match', match: best, alternatives, costTimeMs };
}

export function describeMatch(match: Pick<AcrMatch, 'title' | 'artists'>): string {
  return match.artists.length ? `${match.title} — ${match.artists.join(', ')}` : match.title;
}
