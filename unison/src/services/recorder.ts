import {
  AudioQuality,
  IOSOutputFormat,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  type AudioRecorder,
  type RecordingOptions,
} from 'expo-audio';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';

import { sleep, systemClock, type Clock } from '../core/clock';
import type { CapturedSample } from '../core/sample';

/**
 * Recording profile tuned for fingerprinting, not for listening back:
 * mono, 16 kHz, low-bitrate AAC. ACRCloud fingerprints at 8 kHz internally, so this loses nothing
 * and keeps a 6 s upload around 35-40 KB — the upload leg is usually the largest latency we cannot
 * measure ahead of time, so small files directly improve sync accuracy.
 */
export const SYNC_RECORDING_OPTIONS: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 48_000,
  android: {
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
    // Plain microphone path. Avoid 'voice_communication' / 'voice_recognition': their AGC and noise
    // suppression are tuned for speech and smear the spectral peaks fingerprinting relies on.
    audioSource: 'mic',
  },
  ios: {
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.MEDIUM,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 48_000,
  },
};

export const SAMPLE_MIME_TYPE = Platform.OS === 'web' ? 'audio/webm' : 'audio/mp4';
export const SAMPLE_FILE_NAME = Platform.OS === 'web' ? 'sample.webm' : 'sample.m4a';

export async function ensureMicrophonePermission(): Promise<boolean> {
  const current = await getRecordingPermissionsAsync();
  if (current.granted) return true;
  const requested = await requestRecordingPermissionsAsync();
  return requested.granted;
}

/**
 * Configure the audio session for capture WITHOUT interrupting whatever is playing:
 * `mixWithOthers` keeps the Spotify app (or another app) playing while we record, on both platforms.
 */
export async function prepareAudioSessionForRecording(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
    interruptionMode: 'mixWithOthers',
    shouldRouteThroughEarpiece: false,
  });
}

/** Give the audio session back once we are done recording (iOS restores the playback category). */
export async function releaseAudioSession(): Promise<void> {
  await setAudioModeAsync({ allowsRecording: false, interruptionMode: 'mixWithOthers' });
}

/**
 * Record `durationMs` of ambient audio and return the file plus precise capture timestamps.
 *
 * Timestamps: `record()` returns before the native recorder actually starts capturing (encoder spin-up
 * is typically 30-150 ms), so we do NOT trust "time when we called record()". Instead we read the
 * recorder's own duration just before stopping and back-date `captureStart` from `captureEnd`.
 */
export async function captureSample(recorder: AudioRecorder, durationMs: number, clock: Clock = systemClock): Promise<CapturedSample> {
  await prepareAudioSessionForRecording();
  await recorder.prepareToRecordAsync();

  const recordCalledAt = clock.now();
  recorder.record();
  await sleep(durationMs);

  const statusBeforeStop = recorder.getStatus();
  const beforeStopAt = clock.now();
  await recorder.stop();
  const captureEnd = clock.now();
  void releaseAudioSession().catch(() => undefined);

  const uri = recorder.uri;
  if (!uri) throw new Error('Recorder produced no file');

  // Recorder-reported duration plus the few ms between reading it and the stop completing.
  const reported = statusBeforeStop.durationMillis + (captureEnd - beforeStopAt);
  const plausible = reported > durationMs * 0.5 && reported < durationMs * 1.5;
  const recordedMs = plausible ? reported : captureEnd - recordCalledAt;
  const captureStart = captureEnd - recordedMs;

  return {
    uri,
    fileName: SAMPLE_FILE_NAME,
    mimeType: SAMPLE_MIME_TYPE,
    sizeBytes: await sampleSizeBytes(uri),
    recordedMs,
    timings: { captureStart, captureEnd },
  };
}

async function sampleSizeBytes(uri: string): Promise<number> {
  if (Platform.OS === 'web') {
    const blob = await fetch(uri).then((r) => r.blob());
    return blob.size;
  }
  const file = new File(uri);
  const size = file.size;
  if (typeof size === 'number' && size > 0) return size;
  return (await file.bytes()).byteLength; // fallback; files are tiny
}
