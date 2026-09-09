import type { OffsetAnchor } from './core/sync/latency';

/**
 * Runtime configuration. Expo inlines `process.env.EXPO_PUBLIC_*` at bundle time (see .env.example).
 * Anything here is visible to anyone who unpacks the app, which is why the ACRCloud secret is
 * development-only and production uses the signing proxy.
 */
export interface AppConfig {
  acr: {
    host: string;
    accessKey: string;
    /** DEV ONLY. */
    accessSecret?: string;
    /** Production: server/acr-sign-proxy.mjs endpoint. */
    signProxyUrl?: string;
  };
  spotify: { clientId: string };
  sync: {
    captureMs: number;
    verifyCaptureMs: number;
    verifyDelayMs: number;
    minScore: number;
    driftThresholdMs: number;
    anchor: OffsetAnchor;
  };
}

const env = (key: string): string | undefined => {
  const value = process.env[key];
  return value && value.trim().length > 0 ? value.trim() : undefined;
};

export const config: AppConfig = {
  acr: {
    host: env('EXPO_PUBLIC_ACR_HOST') ?? 'identify-eu-west-1.acrcloud.com',
    accessKey: env('EXPO_PUBLIC_ACR_ACCESS_KEY') ?? '',
    accessSecret: env('EXPO_PUBLIC_ACR_ACCESS_SECRET'),
    signProxyUrl: env('EXPO_PUBLIC_ACR_SIGN_PROXY_URL'),
  },
  spotify: { clientId: env('EXPO_PUBLIC_SPOTIFY_CLIENT_ID') ?? '' },
  sync: {
    captureMs: 6000,
    verifyCaptureMs: 5000,
    verifyDelayMs: 3000,
    minScore: 60,
    driftThresholdMs: 120,
    anchor: 'sample_end',
  },
};

/** Human-readable list of missing settings, empty when everything needed is present. */
export function configProblems(cfg: AppConfig = config): string[] {
  const problems: string[] = [];
  if (!cfg.spotify.clientId) problems.push('EXPO_PUBLIC_SPOTIFY_CLIENT_ID is not set.');
  if (!cfg.acr.signProxyUrl) {
    if (!cfg.acr.accessKey) problems.push('EXPO_PUBLIC_ACR_ACCESS_KEY is not set.');
    if (!cfg.acr.accessSecret) problems.push('Set EXPO_PUBLIC_ACR_ACCESS_SECRET (dev) or EXPO_PUBLIC_ACR_SIGN_PROXY_URL (prod).');
  }
  return problems;
}
