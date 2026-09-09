import { describe, expect, it, vi } from 'vitest';

import { identifySample } from '../core/acrcloud/identify';
import type { AcrSignedFields } from '../core/acrcloud/signing';
import { FakeClock } from '../core/clock';
import type { CapturedSample } from '../core/sample';

const sample: CapturedSample = {
  uri: 'file:///tmp/sample.m4a',
  fileName: 'sample.m4a',
  mimeType: 'audio/mp4',
  sizeBytes: 38_211,
  recordedMs: 6000,
  timings: { captureStart: 10_000, captureEnd: 16_000 },
};

const signed: AcrSignedFields = { access_key: 'AK', data_type: 'audio', signature_version: '1', signature: 'SIG', timestamp: '1700000000' };

describe('identifySample', () => {
  it('posts the documented multipart fields to /v1/identify and times the round trip', async () => {
    const clock = new FakeClock(16_080);
    let received: FormData | undefined;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      received = init.body as FormData;
      clock.advance(900);
      return new Response(JSON.stringify({ status: { code: 0, msg: 'Success', version: '1.0' }, cost_time: 0.4, metadata: { music: [{ acrid: 'x', title: 'T', score: 90, play_offset_ms: 123 }] } }), {
        status: 200,
      });
    });

    const result = await identifySample({
      host: 'identify-eu-west-1.acrcloud.com',
      sample,
      signedFields: Promise.resolve(signed),
      buildSamplePart: async () => new Blob([new Uint8Array(sample.sizeBytes)], { type: sample.mimeType }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock,
    });

    expect(fetchImpl).toHaveBeenCalledWith('https://identify-eu-west-1.acrcloud.com/v1/identify', expect.objectContaining({ method: 'POST' }));
    expect(received).toBeInstanceOf(FormData);
    expect(received?.get('access_key')).toBe('AK');
    expect(received?.get('data_type')).toBe('audio');
    expect(received?.get('signature_version')).toBe('1');
    expect(received?.get('signature')).toBe('SIG');
    expect(received?.get('timestamp')).toBe('1700000000');
    expect(received?.get('sample_bytes')).toBe('38211');
    const part = received?.get('sample') as File;
    expect(part.name).toBe('sample.m4a');
    expect(part.size).toBe(38_211);

    expect(result.httpStatus).toBe(200);
    expect(result.timings).toEqual({ uploadStart: 16_080, responseReceived: 16_980 });
    expect(result.outcome.kind).toBe('match');
    if (result.outcome.kind === 'match') expect(result.outcome.costTimeMs).toBe(400);
  });

  it('turns a non-JSON HTTP failure into an error outcome instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('gateway timeout', { status: 504 }));
    const result = await identifySample({
      host: 'h',
      sample,
      signedFields: signed,
      buildSamplePart: async () => new Blob([]),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.outcome).toEqual({ kind: 'error', code: 504, message: 'HTTP 504' });
  });
});
