import type { Clock } from '../clock';
import { systemClock } from '../clock';
import { hmacSha1Base64 } from '../hmacSha1';

/**
 * ACRCloud Identification API request signing (signature_version 1).
 *
 *   string_to_sign = "POST\n/v1/identify\n{access_key}\n{data_type}\n{signature_version}\n{timestamp}"
 *   signature      = base64( HMAC-SHA1( access_secret, string_to_sign ) )
 *
 * `timestamp` is Unix seconds. `sample_bytes` is sent as a form field but is NOT part of the signature.
 */

export const ACR_IDENTIFY_METHOD = 'POST';
export const ACR_IDENTIFY_PATH = '/v1/identify';
export const ACR_SIGNATURE_VERSION = '1';

export type AcrDataType = 'audio' | 'fingerprint';

export interface AcrSignedFields {
  access_key: string;
  data_type: AcrDataType;
  signature_version: typeof ACR_SIGNATURE_VERSION;
  signature: string;
  timestamp: string;
}

export interface AcrSigningInput {
  accessKey: string;
  accessSecret: string;
  dataType?: AcrDataType;
  /** Unix seconds. Defaults to the clock's wall time. */
  timestampSec?: number;
}

export function identifyUrl(host: string): string {
  const cleanHost = host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `https://${cleanHost}${ACR_IDENTIFY_PATH}`;
}

export function buildStringToSign(
  accessKey: string,
  dataType: AcrDataType,
  signatureVersion: string,
  timestampSec: number | string,
): string {
  return [ACR_IDENTIFY_METHOD, ACR_IDENTIFY_PATH, accessKey, dataType, signatureVersion, String(timestampSec)].join(
    '\n',
  );
}

export function signIdentifyRequest(input: AcrSigningInput, clock: Clock = systemClock): AcrSignedFields {
  const dataType = input.dataType ?? 'audio';
  const timestamp = String(input.timestampSec ?? Math.floor(clock.wallNow() / 1000));
  const stringToSign = buildStringToSign(input.accessKey, dataType, ACR_SIGNATURE_VERSION, timestamp);
  return {
    access_key: input.accessKey,
    data_type: dataType,
    signature_version: ACR_SIGNATURE_VERSION,
    signature: hmacSha1Base64(input.accessSecret, stringToSign),
    timestamp,
  };
}

/**
 * Something that can produce signed fields for one identify request.
 *
 * - `localSigner` signs on-device. Fine for development; NOT for production builds because the
 *   access secret would ship inside the JS bundle.
 * - `remoteSigner` asks a tiny server (server/acr-sign-proxy.mjs) for the fields; the secret stays there.
 *   The audio itself still goes straight from the phone to ACRCloud, so no extra hop on the hot path.
 */
export type AcrSigner = () => Promise<AcrSignedFields>;

export function localSigner(accessKey: string, accessSecret: string, clock: Clock = systemClock): AcrSigner {
  return async () => signIdentifyRequest({ accessKey, accessSecret }, clock);
}

export function remoteSigner(proxyUrl: string, fetchImpl: typeof fetch = fetch): AcrSigner {
  return async () => {
    const res = await fetchImpl(proxyUrl, { method: 'POST', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`ACR signing proxy returned HTTP ${res.status}`);
    const fields = (await res.json()) as Partial<AcrSignedFields>;
    if (!fields.access_key || !fields.signature || !fields.timestamp) {
      throw new Error('ACR signing proxy returned an incomplete payload');
    }
    return {
      access_key: fields.access_key,
      data_type: fields.data_type ?? 'audio',
      signature_version: ACR_SIGNATURE_VERSION,
      signature: fields.signature,
      timestamp: String(fields.timestamp),
    };
  };
}
