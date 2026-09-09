import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  ACR_SIGNATURE_VERSION,
  buildStringToSign,
  identifyUrl,
  localSigner,
  remoteSigner,
  signIdentifyRequest,
} from '../core/acrcloud/signing';
import { FakeClock } from '../core/clock';

describe('ACRCloud request signing', () => {
  it('builds the documented string_to_sign', () => {
    expect(buildStringToSign('AK', 'audio', '1', 1700000000)).toBe('POST\n/v1/identify\nAK\naudio\n1\n1700000000');
  });

  it('produces base64(HMAC-SHA1(secret, string_to_sign)) with the expected form fields', () => {
    const fields = signIdentifyRequest({ accessKey: 'AK', accessSecret: 'SECRET', timestampSec: 1700000000 });
    const expected = createHmac('sha1', 'SECRET').update('POST\n/v1/identify\nAK\naudio\n1\n1700000000').digest('base64');
    expect(fields).toEqual({
      access_key: 'AK',
      data_type: 'audio',
      signature_version: ACR_SIGNATURE_VERSION,
      signature: expected,
      timestamp: '1700000000',
    });
  });

  it('defaults the timestamp to the clock wall time in whole seconds', () => {
    const clock = new FakeClock(0, 1_700_000_000_999);
    const fields = signIdentifyRequest({ accessKey: 'AK', accessSecret: 'S' }, clock);
    expect(fields.timestamp).toBe('1700000000');
  });

  it('normalises the host into the identify URL', () => {
    expect(identifyUrl('identify-eu-west-1.acrcloud.com')).toBe('https://identify-eu-west-1.acrcloud.com/v1/identify');
    expect(identifyUrl('https://identify-us-west-2.acrcloud.com/')).toBe('https://identify-us-west-2.acrcloud.com/v1/identify');
  });

  it('localSigner signs with the clock it was given', async () => {
    const clock = new FakeClock(0, 1_700_000_000_000);
    const fields = await localSigner('AK', 'S', clock)();
    expect(fields.timestamp).toBe('1700000000');
    expect(fields.signature).toBe(createHmac('sha1', 'S').update('POST\n/v1/identify\nAK\naudio\n1\n1700000000').digest('base64'));
  });

  it('remoteSigner POSTs to the proxy and validates the payload', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_key: 'AK', signature: 'sig', timestamp: 1700000000, data_type: 'audio' }), { status: 200 }),
    );
    const fields = await remoteSigner('https://proxy.example/sign', fetchImpl as unknown as typeof fetch)();
    expect(fetchImpl).toHaveBeenCalledWith('https://proxy.example/sign', expect.objectContaining({ method: 'POST' }));
    expect(fields).toMatchObject({ access_key: 'AK', signature: 'sig', timestamp: '1700000000', signature_version: '1' });

    const bad = vi.fn(async () => new Response('{}', { status: 200 }));
    await expect(remoteSigner('https://proxy.example/sign', bad as unknown as typeof fetch)()).rejects.toThrow(/incomplete/);
  });
});
