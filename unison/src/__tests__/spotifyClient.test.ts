import { describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../core/clock';
import { SpotifyClient, userFacingSpotifyMessage } from '../core/spotify/client';
import { SpotifyApiError } from '../core/spotify/types';

interface Recorded {
  url: string;
  init: RequestInit;
}

function makeClient(handler: (req: Recorded) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const clock = new FakeClock(1000);
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    clock.advance(40); // pretend every request takes 40 ms
    return handler({ url, init });
  });
  const client = new SpotifyClient({ getAccessToken: async () => 'tok', fetchImpl: fetchImpl as unknown as typeof fetch, clock });
  return { client, calls, clock };
}

describe('SpotifyClient.play', () => {
  it('PUTs /me/player/play with uris + position_ms and the device id, and reports timings', async () => {
    const { client, calls } = makeClient(() => new Response(null, { status: 204 }));
    const receipt = await client.play({ uri: 'spotify:track:abc', positionMs: 61_320.6, deviceId: 'dev1' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.spotify.com/v1/me/player/play?device_id=dev1');
    expect(calls[0].init.method).toBe('PUT');
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ uris: ['spotify:track:abc'], position_ms: 61_321 });
    expect(receipt).toEqual({ dispatchAt: 1000, ackAt: 1040, uri: 'spotify:track:abc', positionMs: 61_321 });
  });

  it('omits device_id when not provided', async () => {
    const { client, calls } = makeClient(() => new Response(null, { status: 204 }));
    await client.play({ uri: 'spotify:track:abc', positionMs: 0 });
    expect(calls[0].url).toBe('https://api.spotify.com/v1/me/player/play');
  });

  it('maps 404 NO_ACTIVE_DEVICE to a typed error with a helpful message', async () => {
    const { client } = makeClient(
      () => new Response(JSON.stringify({ error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } }), { status: 404 }),
    );
    const err = await client.play({ uri: 'spotify:track:abc', positionMs: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpotifyApiError);
    expect((err as SpotifyApiError).reason).toBe('NO_ACTIVE_DEVICE');
    expect(userFacingSpotifyMessage(err)).toMatch(/Open Spotify/);
  });

  it('maps 403 PREMIUM_REQUIRED and 401', async () => {
    const premium = makeClient(() => new Response(JSON.stringify({ error: { status: 403, message: 'Premium required', reason: 'PREMIUM_REQUIRED' } }), { status: 403 }));
    await expect(premium.client.play({ uri: 'x', positionMs: 0 })).rejects.toMatchObject({ reason: 'PREMIUM_REQUIRED' });
    const unauth = makeClient(() => new Response('', { status: 401 }));
    await expect(unauth.client.play({ uri: 'x', positionMs: 0 })).rejects.toMatchObject({ reason: 'UNAUTHORIZED', status: 401 });
  });

  it('retries once after a 429 using Retry-After', async () => {
    let n = 0;
    const { client, calls } = makeClient(() => (n++ === 0 ? new Response('', { status: 429, headers: { 'Retry-After': '0' } }) : new Response(null, { status: 204 })));
    await client.play({ uri: 'x', positionMs: 5 });
    expect(calls).toHaveLength(2);
  });
});

describe('SpotifyClient.seek / getPlaybackState / findTrack', () => {
  it('seek PUTs position_ms as a query parameter', async () => {
    const { client, calls } = makeClient(() => new Response(null, { status: 204 }));
    await client.seek(71_200.4);
    expect(calls[0].url).toBe('https://api.spotify.com/v1/me/player/seek?position_ms=71200');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('getPlaybackState returns null on 204 and the state otherwise, with timings', async () => {
    const idle = makeClient(() => new Response(null, { status: 204 }));
    expect(await idle.client.getPlaybackState()).toEqual({ dispatchAt: 1000, ackAt: 1040, state: null });

    const state = { is_playing: true, progress_ms: 61_500, item: { uri: 'spotify:track:abc' } };
    const playing = makeClient(() => new Response(JSON.stringify(state), { status: 200 }));
    const result = await playing.client.getPlaybackState();
    expect(result.state).toMatchObject(state);
    expect(playing.calls[0].url).toBe('https://api.spotify.com/v1/me/player?additional_types=track');
  });

  it('findTrack prefers an exact ISRC hit and falls back to title/artist search', async () => {
    const isrcHit = { uri: 'spotify:track:isrc', external_ids: { isrc: 'USUG11904206' }, name: 'A', artists: [], duration_ms: 1 };
    const { client, calls } = makeClient(({ url }) =>
      url.includes('isrc%3A')
        ? new Response(JSON.stringify({ tracks: { items: [{ ...isrcHit, uri: 'spotify:track:other', external_ids: { isrc: 'OTHER' } }, isrcHit] } }))
        : new Response(JSON.stringify({ tracks: { items: [{ uri: 'spotify:track:fuzzy' }] } })),
    );
    const byIsrc = await client.findTrack({ isrc: 'usug11904206', title: 'A', artists: ['B'] });
    expect(byIsrc?.uri).toBe('spotify:track:isrc');
    expect(calls[0].url).toContain('q=isrc%3AUSUG11904206');
    expect(calls[0].url).toContain('type=track');

    const fuzzy = await client.findTrack({ title: 'Blinding Lights', artists: ['The Weeknd'] });
    expect(fuzzy?.uri).toBe('spotify:track:fuzzy');
    expect(new URL(calls[1].url).searchParams.get('q')).toBe('track:"Blinding Lights" artist:"The Weeknd"');
  });
});
