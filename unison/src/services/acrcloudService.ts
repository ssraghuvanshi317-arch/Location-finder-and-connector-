import { Platform } from 'react-native';

import { identifySample, type IdentifyOptions, type IdentifyResult, type SamplePartBuilder } from '../core/acrcloud/identify';
import type { CapturedSample } from '../core/sample';

/**
 * Platform-specific multipart body part for the recording.
 * - Native: hand fetch a `{ uri, name, type }` descriptor; React Native streams the file from disk.
 * - Web: the recorder gives us a blob: URL — turn it back into a Blob.
 */
export const platformSamplePart: SamplePartBuilder = async (sample: CapturedSample) => {
  if (Platform.OS === 'web') {
    return fetch(sample.uri).then((r) => r.blob());
  }
  return { uri: sample.uri, name: sample.fileName, type: sample.mimeType };
};

export type IdentifyRequest = Omit<IdentifyOptions, 'buildSamplePart'>;

export function identifyWithPlatformUpload(request: IdentifyRequest): Promise<IdentifyResult> {
  return identifySample({ ...request, buildSamplePart: platformSamplePart });
}
