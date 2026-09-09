import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ResponseType,
  exchangeCodeAsync,
  makeRedirectUri,
  refreshAsync,
  useAuthRequest,
  type DiscoveryDocument,
  type TokenResponse,
} from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { SPOTIFY_SCOPES } from '../core/spotify/types';

// Lets the web auth popup hand its result back to the opener.
WebBrowser.maybeCompleteAuthSession();

/**
 * Spotify OAuth 2.0 Authorization Code + PKCE. No client secret is involved anywhere, which is the
 * only flow that is safe to run inside a mobile app.
 *
 * Register BOTH of these as Redirect URIs in the Spotify developer dashboard:
 *   - unison://spotify-auth                (iOS / Android, from app.json "scheme")
 *   - https://<your-web-origin>/spotify-auth (web; Spotify requires https or http://127.0.0.1)
 */
export const spotifyDiscovery: DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.spotify.com/authorize',
  tokenEndpoint: 'https://accounts.spotify.com/api/token',
};

export const spotifyRedirectUri = makeRedirectUri({ scheme: 'unison', path: 'spotify-auth' });

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  /** Unix ms. */
  expiresAtWall: number;
  scope?: string;
}

const TOKEN_KEY = 'unison.spotify.tokens';

/** SecureStore (Keychain / Keystore) on native; AsyncStorage on web where SecureStore is unavailable. */
export const tokenStore = {
  async load(): Promise<StoredTokens | null> {
    try {
      const raw = Platform.OS === 'web' ? await AsyncStorage.getItem(TOKEN_KEY) : await SecureStore.getItemAsync(TOKEN_KEY);
      return raw ? (JSON.parse(raw) as StoredTokens) : null;
    } catch {
      return null;
    }
  },
  async save(tokens: StoredTokens): Promise<void> {
    const raw = JSON.stringify(tokens);
    if (Platform.OS === 'web') await AsyncStorage.setItem(TOKEN_KEY, raw);
    else await SecureStore.setItemAsync(TOKEN_KEY, raw);
  },
  async clear(): Promise<void> {
    if (Platform.OS === 'web') await AsyncStorage.removeItem(TOKEN_KEY);
    else await SecureStore.deleteItemAsync(TOKEN_KEY);
  },
};

function fromTokenResponse(response: TokenResponse, previousRefreshToken?: string): StoredTokens {
  const issuedAtMs = (response.issuedAt ?? Math.floor(Date.now() / 1000)) * 1000;
  const expiresInMs = (response.expiresIn ?? 3600) * 1000;
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken ?? previousRefreshToken,
    expiresAtWall: issuedAtMs + expiresInMs,
    scope: response.scope,
  };
}

export interface SpotifyAuth {
  /** True once the auth request has loaded (PKCE verifier generated) and the connect button can be pressed. */
  ready: boolean;
  isConnected: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Returns a valid token, refreshing transparently when it is within 60 s of expiry. */
  getAccessToken: () => Promise<string>;
}

export function useSpotifyAuth(clientId: string): SpotifyAuth {
  const [tokens, setTokens] = useState<StoredTokens | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tokensRef = useRef<StoredTokens | null>(null);
  tokensRef.current = tokens;

  const [request, response, promptAsync] = useAuthRequest(
    {
      clientId,
      scopes: [...SPOTIFY_SCOPES],
      usePKCE: true,
      responseType: ResponseType.Code,
      redirectUri: spotifyRedirectUri,
    },
    spotifyDiscovery,
  );

  useEffect(() => {
    tokenStore.load().then((stored) => {
      if (stored) setTokens(stored);
    });
  }, []);

  useEffect(() => {
    if (!response) return;
    if (response.type === 'error') {
      setError(response.error?.message ?? 'Spotify authorisation failed');
      return;
    }
    if (response.type !== 'success' || !request?.codeVerifier) return;

    exchangeCodeAsync(
      {
        clientId,
        code: response.params.code,
        redirectUri: spotifyRedirectUri,
        extraParams: { code_verifier: request.codeVerifier },
      },
      spotifyDiscovery,
    )
      .then((tokenResponse) => {
        const stored = fromTokenResponse(tokenResponse);
        setTokens(stored);
        setError(null);
        return tokenStore.save(stored);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [response, request, clientId]);

  const connect = useCallback(async () => {
    setError(null);
    await promptAsync();
  }, [promptAsync]);

  const disconnect = useCallback(async () => {
    setTokens(null);
    await tokenStore.clear();
  }, []);

  const getAccessToken = useCallback(async () => {
    let current = tokensRef.current ?? (await tokenStore.load());
    if (!current) throw new Error('Spotify is not connected');

    if (current.expiresAtWall - Date.now() < 60_000) {
      if (!current.refreshToken) throw new Error('Spotify session expired; reconnect');
      const refreshed = await refreshAsync({ clientId, refreshToken: current.refreshToken }, spotifyDiscovery);
      current = fromTokenResponse(refreshed, current.refreshToken);
      tokensRef.current = current;
      setTokens(current);
      await tokenStore.save(current);
    }
    return current.accessToken;
  }, [clientId]);

  return { ready: !!request, isConnected: !!tokens, error, connect, disconnect, getAccessToken };
}
