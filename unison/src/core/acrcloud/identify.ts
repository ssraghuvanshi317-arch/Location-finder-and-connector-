import type { Clock } from '../clock';
import { systemClock } from '../clock';
import type { CapturedSample } from '../sample';
import { parseIdentifyResponse } from './parse';
import { identifyUrl, type AcrSignedFields } from './signing';
import type { AcrIdentifyOutcome } from './types';

/**
 * Multipart part for the `sample` field. React Native's FormData accepts `{ uri, name, type }` and
 * streams the file from disk; browsers need a real Blob.
 */
export type SamplePart = Blob | { uri: string; name: string; type: string };
export type SamplePartBuilder = (sample: CapturedSample) => Promise<SamplePart>;

export interface IdentifyOptions {
  host: string;
  sample: CapturedSample;
  /** Pre-computed (ideally pre-fetched, see SyncSession) signature fields. */
  signedFields: AcrSignedFields | Promise<AcrSignedFields>;
  buildSamplePart: SamplePartBuilder;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  /** Abort the upload after this long (default 10 s). */
  timeoutMs?: number;
  /** Discard matches below this ACRCloud score (0-100). */
  minScore?: number;
}

export interface IdentifyResult {
  outcome: AcrIdentifyOutcome;
  timings: {
    /** Monotonic ms when the request was handed to fetch. */
    uploadStart: number;
    /** Monotonic ms when the JSON body had been received and parsed. */
    responseReceived: number;
  };
  httpStatus: number;
}

/** POST the sample to ACRCloud's /v1/identify and time the round trip. */
export async function identifySample(options: IdentifyOptions): Promise<IdentifyResult> {
  const clock = options.clock ?? systemClock;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const [fields, part] = await Promise.all([options.signedFields, options.buildSamplePart(options.sample)]);

  const form = new FormData();
  form.append('access_key', fields.access_key);
  form.append('data_type', fields.data_type);
  form.append('signature_version', fields.signature_version);
  form.append('signature', fields.signature);
  form.append('timestamp', fields.timestamp);
  form.append('sample_bytes', String(options.sample.sizeBytes));
  // RN accepts the {uri,name,type} descriptor here; the cast keeps DOM typings happy.
  form.append('sample', part as unknown as Blob, options.sample.fileName);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const uploadStart = clock.now();
    const res = await fetchImpl(identifyUrl(options.host), { method: 'POST', body: form, signal: controller.signal });
    const json: unknown = await res.json().catch(() => null);
    const responseReceived = clock.now();
    return {
      outcome: res.ok || json ? parseIdentifyResponse(json, options.minScore) : { kind: 'error', code: res.status, message: `HTTP ${res.status}` },
      timings: { uploadStart, responseReceived },
      httpStatus: res.status,
    };
  } finally {
    clearTimeout(timer);
  }
}
