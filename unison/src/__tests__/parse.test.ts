import { describe, expect, it } from 'vitest';

import { describeMatch, parseIdentifyResponse } from '../core/acrcloud/parse';

const fixture = {
  status: { msg: 'Success', version: '1.0', code: 0 },
  cost_time: 0.662,
  result_type: 0,
  metadata: {
    timestamp_utc: '2026-09-09 08:00:00',
    music: [
      {
        acrid: 'lowscore',
        title: 'Wrong Song',
        artists: [{ name: 'Nobody' }],
        score: 55,
        play_offset_ms: 1000,
        duration_ms: 200000,
      },
      {
        acrid: 'a1b2c3',
        title: 'Blinding Lights',
        artists: [{ name: 'The Weeknd' }],
        album: { name: 'After Hours' },
        release_date: '2020-03-20',
        score: 100,
        duration_ms: 200040,
        play_offset_ms: 61230,
        sample_begin_time_offset_ms: 0,
        sample_end_time_offset_ms: 5800,
        db_begin_time_offset_ms: 55430,
        db_end_time_offset_ms: 61230,
        external_ids: { isrc: 'USUG11904206' },
        external_metadata: { spotify: { track: { id: '0VjIjW4GlUZAMYd2vXMi3b' } }, youtube: { vid: '4NRXx6U8ABQ' } },
      },
      { acrid: 'nooffset', title: 'No Offset', score: 100 },
    ],
  },
};

describe('parseIdentifyResponse', () => {
  it('picks the highest-scoring result that carries a play offset and maps sync fields', () => {
    const outcome = parseIdentifyResponse(fixture);
    expect(outcome.kind).toBe('match');
    if (outcome.kind !== 'match') return;
    expect(outcome.costTimeMs).toBe(662);
    expect(outcome.match).toMatchObject({
      acrid: 'a1b2c3',
      title: 'Blinding Lights',
      artists: ['The Weeknd'],
      album: 'After Hours',
      score: 100,
      durationMs: 200040,
      playOffsetMs: 61230,
      sampleEndOffsetMs: 5800,
      dbEndOffsetMs: 61230,
      isrc: 'USUG11904206',
      spotifyTrackId: '0VjIjW4GlUZAMYd2vXMi3b',
      spotifyUri: 'spotify:track:0VjIjW4GlUZAMYd2vXMi3b',
    });
    expect(outcome.alternatives.map((m) => m.acrid)).toEqual(['lowscore']);
    expect(describeMatch(outcome.match)).toBe('Blinding Lights — The Weeknd');
  });

  it('applies the minimum score', () => {
    const outcome = parseIdentifyResponse(fixture, 60);
    expect(outcome.kind).toBe('match');
    if (outcome.kind === 'match') expect(outcome.alternatives).toHaveLength(0);
  });

  it('maps 1001 to no_match and other codes to errors with friendly messages', () => {
    expect(parseIdentifyResponse({ status: { code: 1001, msg: 'No result', version: '1.0' } })).toEqual({ kind: 'no_match', costTimeMs: undefined });
    expect(parseIdentifyResponse({ status: { code: 3014, msg: 'x', version: '1.0' } })).toEqual({ kind: 'error', code: 3014, message: 'Invalid signature' });
    expect(parseIdentifyResponse({ status: { code: 9999, msg: 'Weird', version: '1.0' } })).toEqual({ kind: 'error', code: 9999, message: 'Weird' });
    expect(parseIdentifyResponse(null).kind).toBe('error');
    expect(parseIdentifyResponse({ status: { code: 0 }, metadata: { music: [] } })).toEqual({ kind: 'no_match', costTimeMs: undefined });
  });
});
