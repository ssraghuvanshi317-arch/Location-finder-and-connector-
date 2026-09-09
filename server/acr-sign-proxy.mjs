#!/usr/bin/env node
/**
 * ACRCloud signing proxy — keeps the ACRCloud access secret OFF the phone.
 *
 * The app asks this endpoint for a freshly signed set of form fields, then uploads the audio
 * straight to ACRCloud itself. The proxy never sees the audio, so it adds no latency to the hot
 * path (and the app even prefetches the signature while it is still recording).
 *
 *   ACR_ACCESS_KEY=... ACR_ACCESS_SECRET=... node server/acr-sign-proxy.mjs
 *   curl -X POST http://localhost:8787/sign
 *
 * Production hardening (out of scope for this starter): put it behind HTTPS, require an app-level
 * auth token (App Attest / Play Integrity or a signed-in user), and rate-limit per user — an
 * unauthenticated signer lets anyone spend your ACRCloud quota.
 */
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);
const ACCESS_KEY = process.env.ACR_ACCESS_KEY;
const ACCESS_SECRET = process.env.ACR_ACCESS_SECRET;
const DATA_TYPE = 'audio';
const SIGNATURE_VERSION = '1';

if (!ACCESS_KEY || !ACCESS_SECRET) {
  console.error('Set ACR_ACCESS_KEY and ACR_ACCESS_SECRET');
  process.exit(1);
}

/** Identical to unison/src/core/acrcloud/signing.ts, but with Node's crypto. */
export function signIdentifyRequest(accessKey, accessSecret, timestampSec = Math.floor(Date.now() / 1000)) {
  const stringToSign = ['POST', '/v1/identify', accessKey, DATA_TYPE, SIGNATURE_VERSION, String(timestampSec)].join('\n');
  const signature = createHmac('sha1', accessSecret).update(stringToSign).digest('base64');
  return {
    access_key: accessKey,
    data_type: DATA_TYPE,
    signature_version: SIGNATURE_VERSION,
    signature,
    timestamp: String(timestampSec),
  };
}

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // needed for the web build; tighten to your origin
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== 'POST' || req.url !== '/sign') {
    res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const fields = signIdentifyRequest(ACCESS_KEY, ACCESS_SECRET);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(fields));
});

server.listen(PORT, () => {
  console.log(`ACRCloud signing proxy listening on http://localhost:${PORT}/sign`);
});
