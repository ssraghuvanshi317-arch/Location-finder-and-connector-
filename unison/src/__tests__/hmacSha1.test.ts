import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { base64Encode, hmacSha1, hmacSha1Base64, sha1, utf8Bytes } from '../core/hmacSha1';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('sha1', () => {
  it('matches known vectors', () => {
    expect(hex(sha1(utf8Bytes('')))).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(hex(sha1(utf8Bytes('abc')))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(hex(sha1(utf8Bytes('The quick brown fox jumps over the lazy dog')))).toBe('2fd4e1c67a2d28fced849ee1bb76e7391b93eb12');
  });

  it('matches Node across block boundaries (55, 56, 63, 64, 65 bytes and large inputs)', () => {
    for (const len of [55, 56, 57, 63, 64, 65, 119, 120, 1000, 4097]) {
      const msg = new Uint8Array(len).map((_, i) => (i * 31 + 7) & 0xff);
      expect(hex(sha1(msg))).toBe(createHash('sha1').update(msg).digest('hex'));
    }
  });
});

describe('hmacSha1', () => {
  const cases: [string, string][] = [
    ['key', 'The quick brown fox jumps over the lazy dog'],
    ['', ''],
    ['a'.repeat(64), 'block-sized key'],
    ['k'.repeat(200), 'key longer than the block size must be hashed first'],
    ['secret-🔑', 'unicode message: ünïcødé ✓ 日本語'],
    ['acr-secret', 'POST\n/v1/identify\nkey\naudio\n1\n1700000000'],
  ];

  it.each(cases)('matches Node for key=%j', (key, message) => {
    const expected = createHmac('sha1', key).update(message).digest('base64');
    expect(hmacSha1Base64(key, message)).toBe(expected);
    expect(hex(hmacSha1(key, message))).toBe(createHmac('sha1', key).update(message).digest('hex'));
  });

  it('RFC 2202 test case 1', () => {
    const key = new Uint8Array(20).fill(0x0b);
    expect(hex(hmacSha1(key, 'Hi There'))).toBe('b617318655057264e28bc0b6fb378c8ef146be00');
  });
});

describe('base64Encode', () => {
  it('matches Buffer for every remainder length', () => {
    for (let len = 0; len < 10; len++) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37) & 0xff);
      expect(base64Encode(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
});

describe('utf8Bytes', () => {
  it('encodes supplementary-plane characters as 4 bytes', () => {
    expect(Array.from(utf8Bytes('😀'))).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });
});
