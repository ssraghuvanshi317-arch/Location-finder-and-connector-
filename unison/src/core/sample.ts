/** A finished microphone recording plus the timestamps the sync math needs. Platform-agnostic. */
export interface CapturedSample {
  /** file:// URI on native, blob: URL on web. */
  uri: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Duration of audio actually captured according to the recorder. */
  recordedMs: number;
  timings: {
    /** Monotonic ms when the first audio frame was captured. */
    captureStart: number;
    /** Monotonic ms when the last audio frame was captured. */
    captureEnd: number;
  };
}
