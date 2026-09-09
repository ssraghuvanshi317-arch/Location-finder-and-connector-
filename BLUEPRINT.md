# Unison — Project Blueprint

**Goal.** A cross-platform app (iOS, Android, web) that listens to the music playing around the user,
identifies the song *and the exact position it is at*, and starts the same track on the user's own
Spotify so both play in unison — for example, so you can hear the bar's music in your own headphones,
or so a group of phones can play the same song as a portable speaker set.

This document is the engineering blueprint. The starter code that implements it lives in
[`unison/`](unison/) and is unit-tested end-to-end in Node with a fake clock, so every latency
formula below is executable and checked.

---

## 1. Tech stack

| Concern | Choice | Why |
| --- | --- | --- |
| Cross-platform framework | **React Native + Expo (SDK 57), TypeScript** | One codebase for iOS/Android/web; `expo-audio` wraps microphone permission + capture on all three; `expo-auth-session` does OAuth PKCE on all three; config plugins inject `NSMicrophoneUsageDescription` / `RECORD_AUDIO` so no native code is touched. The entire sync core is plain TypeScript that runs (and is tested) in Node. |
| Flutter (considered) | — | Equally capable (`record` + `flutter_appauth`), but the Spotify Web API / ACRCloud integration is pure HTTP either way, and Expo's config-plugin story means zero Xcode/Gradle edits. Pick Flutter if the team is Dart-native; nothing in the math changes. |
| Audio recognition | **ACRCloud Identification API** | The only mainstream ACR service that returns `play_offset_ms` (and paired `sample_*` / `db_*` offsets) — the position inside the reference track — which is the whole basis of the sync. |
| Playback | **Spotify Web API** `PUT /v1/me/player/play` with `position_ms` | Works against any Spotify Connect device (the phone itself, a speaker, a desktop). Requires Premium. |
| Auth | Spotify **Authorization Code + PKCE** via `expo-auth-session` | No client secret inside a mobile app. Tokens in Keychain/Keystore (`expo-secure-store`). |
| Secrets | ACRCloud secret stays on a **signing proxy** (`server/acr-sign-proxy.mjs`) | The identify request is HMAC-SHA1-signed; the proxy returns only the signed fields, and the phone uploads audio straight to ACRCloud. |
| Tests | **vitest** on `src/core` + `src/orchestrator` | Pure TS, dependency-injected; no simulator needed for the sync math. |

---

## 2. Repository layout

```
BLUEPRINT.md                     ← this document
README.md
server/acr-sign-proxy.mjs        ← 60-line Node signer (keeps the ACRCloud secret off the device)
unison/                          ← Expo app
  App.tsx, index.ts, app.json    ← entry + config (scheme "unison", mic permission strings)
  .env.example                   ← EXPO_PUBLIC_* settings
  src/config.ts                  ← typed config + "what is missing" helper
  src/core/                      ← PURE TypeScript, no React Native imports
    clock.ts                     ← monotonic Clock + FakeClock for tests
    hmacSha1.ts                  ← dependency-free SHA-1 / HMAC / Base64 (verified vs Node crypto)
    sample.ts                    ← CapturedSample: file + capture timestamps
    acrcloud/signing.ts          ← string_to_sign, signature, local & remote signers
    acrcloud/identify.ts         ← multipart POST /v1/identify with timing
    acrcloud/parse.ts, types.ts  ← response → AcrMatch (play_offset_ms, spotify id, isrc, offsets)
    spotify/client.ts, types.ts  ← play(position_ms) / seek / playback state / devices / ISRC search
    sync/latency.ts              ← computeTargetPosition — THE formula, with a full breakdown
    sync/calibration.ts          ← device start-up latency: measurement + EMA model
    sync/drift.ts                ← second-pass verification → one corrective seek
  src/orchestrator/syncSession.ts← the pipeline (listen → identify → play → calibrate → verify)
  src/services/                  ← platform glue: expo-audio recorder, upload part, PKCE auth, storage
  src/ui/SyncScreen.tsx          ← one screen: connect, Listen & Sync, latency budget, ±100 ms nudge
  src/__tests__/                 ← 58 tests incl. a fake "world" that proves the sync lands
```

---

## 3. Architecture

```
┌──────────────────────────────┐        ┌────────────────────────────┐
│  Phone (Expo app)            │        │  ACRCloud                  │
│                              │  (2)   │  POST /v1/identify         │
│  mic ──▶ expo-audio ──▶ file ├───────▶│  → play_offset_ms,         │
│      (6 s, mono 16 kHz AAC)  │◀───────┤    db/sample offsets,      │
│                              │  (3)   │    spotify track id, isrc  │
│  SyncSession                 │        └────────────────────────────┘
│   ├ computeTargetPosition    │
│   ├ SpotifyClient.play ──────┼──(4)──▶ Spotify Web API ──▶ Spotify Connect device
│   ├ probe /me/player ────────┼──(5)──▶ (phone / speaker / desktop)
│   └ verify: record again ────┼──(6)──▶ ACRCloud again → seek if drift > 120 ms
│                              │
│  signature prefetch ─────────┼──(1)──▶ server/acr-sign-proxy.mjs (secret lives here)
└──────────────────────────────┘
```

Everything the pipeline needs from the outside world (clock, microphone, signer, ACRCloud upload,
Spotify, calibration storage) is injected through `SyncDeps`, which is why the whole flow can be
simulated in a unit test.

---

## 4. The pipeline, step by step

| # | Phase | What happens | Code |
| --- | --- | --- | --- |
| 1 | `listening` | Prefetch the ACRCloud signature and the stored calibration **while recording**, so neither adds latency. Record 6 s of ambient audio with `mixWithOthers` so the room's own Spotify (if it is this phone) keeps playing. | `services/recorder.ts` |
| 2 | `identifying` | Multipart POST to `/v1/identify`; stamp `uploadStart` / `responseReceived`. | `core/acrcloud/identify.ts` |
| 3 | `resolving` | Take `external_metadata.spotify.track.id`; otherwise search Spotify by **ISRC** (same master ⇒ same timeline), then title + artist. Warn if the Spotify track's length differs > 2 s from ACRCloud's reference (different master ⇒ offsets will not line up). | `syncSession.ts`, `spotify/client.ts` |
| 4 | `starting` | Read the clock, compute `position_ms` (Section 6), `PUT /me/player/play`. | `sync/latency.ts` |
| 5 | `calibrating` | Poll `GET /me/player` every 300 ms (≤ 6×) until the device reports our track; derive the real start-up latency and update the per-device EMA. | `sync/calibration.ts` |
| 6 | `verifying` / `correcting` | After 3 s, record 5 s again, identify again, and probe the player the instant the recording stops. If room and player disagree by > 120 ms, one `seek`. Feed the observed error back into the calibration. | `sync/drift.ts` |
| 7 | `synced` | Show the full latency budget; ± 100 ms nudge buttons seek live and remember a manual trim. | `ui/SyncScreen.tsx` |

---

## 5. ACRCloud integration

### 5.1 Request

`POST https://{region-host}/v1/identify`, `multipart/form-data`:

| Field | Value |
| --- | --- |
| `access_key` | project access key |
| `data_type` | `audio` (we upload the encoded file; ACRCloud fingerprints server-side) |
| `signature_version` | `1` |
| `timestamp` | Unix seconds |
| `signature` | `base64( HMAC-SHA1( access_secret, "POST\n/v1/identify\n{access_key}\naudio\n1\n{timestamp}" ) )` |
| `sample_bytes` | byte length of the file |
| `sample` | the audio file |

`core/acrcloud/signing.ts` builds this; `hmacSha1.test.ts` and `signing.test.ts` verify the signature
byte-for-byte against Node's `crypto`. The **signature is independent of the audio**, which is what
lets the app prefetch it from the proxy before the recording finishes.

### 5.2 Recording profile

Mono, 16 kHz, 48 kbps AAC (`.m4a`; WebM/Opus on web). ACRCloud fingerprints at 8 kHz internally, so this
loses nothing, and a 6 s sample is ≈ 35-40 KB — the upload leg is the largest latency we cannot know
in advance, so small files directly improve accuracy. Android uses the plain `mic` source: the
`voice_*` sources apply AGC/noise-suppression tuned for speech that smears the spectral peaks
fingerprinting relies on.

### 5.3 Response fields that matter

```jsonc
{
  "status": { "code": 0 },            // 1001 = no match; 3014 = bad signature; 3003 = quota
  "cost_time": 0.662,                 // ACRCloud processing, SECONDS
  "metadata": { "music": [{
    "acrid": "…", "title": "Blinding Lights", "artists": [{ "name": "The Weeknd" }],
    "score": 100, "duration_ms": 200040,
    "play_offset_ms": 61230,          // reference-track position lined up with the END of the sample
    "sample_begin_time_offset_ms": 0, "sample_end_time_offset_ms": 5800,   // inside OUR file
    "db_begin_time_offset_ms": 55430, "db_end_time_offset_ms": 61230,      // inside the REFERENCE
    "external_ids": { "isrc": "USUG11904206" },
    "external_metadata": { "spotify": { "track": { "id": "0VjIjW4GlUZAMYd2vXMi3b" } } }
  }]}
}
```

### 5.4 Offset anchoring (important)

ACRCloud documents `play_offset_ms` as "position of the recognition in the file if the file was
playing". In practice it corresponds to the **end** of the matched region, i.e. where the song was when
the recording stopped. Two safeguards, both in `referencePositionAtCaptureEnd()`:

1. **Prefer the paired offsets.** `sample_end_time_offset_ms` is a point inside our file and
   `db_end_time_offset_ms` is the matching point in the reference. The recording continued for
   `captureMs − sample_end` after that point, so the reference position at capture end is
   `db_end + (captureMs − sample_end)`. This is correct *whatever* `play_offset_ms` is anchored to.
2. **Fallback with an explicit assumption.** If the paired offsets are absent, use `play_offset_ms`
   with `anchor: 'sample_end'` (default). If a device test shows playback consistently *behind* by
   about one recording length, flip `config.sync.anchor` to `'sample_start'`.

### 5.5 Secret handling

Anything in an Expo bundle can be extracted. `localSigner` (secret in `.env`) is for development only;
production builds set `EXPO_PUBLIC_ACR_SIGN_PROXY_URL` and use `remoteSigner`, which asks
`server/acr-sign-proxy.mjs` for the signed fields. The proxy never touches audio, so it is off the hot
path. Harden it with an app-attestation or signed-in-user check and per-user rate limits before launch —
an open signer lets anyone spend your ACRCloud quota.

---

## 6. Spotify integration

### 6.1 Auth (PKCE)

```ts
discovery = { authorizationEndpoint: 'https://accounts.spotify.com/authorize',
              tokenEndpoint:         'https://accounts.spotify.com/api/token' }
useAuthRequest({ clientId, scopes, usePKCE: true, responseType: 'code',
                 redirectUri: makeRedirectUri({ scheme: 'unison', path: 'spotify-auth' }) }, discovery)
exchangeCodeAsync({ clientId, code, redirectUri, extraParams: { code_verifier } }, discovery)
refreshAsync({ clientId, refreshToken }, discovery)   // 60 s before expiry, transparently
```

Scopes: `user-modify-playback-state`, `user-read-playback-state`, `user-read-currently-playing`.
Register `unison://spotify-auth` (native) and your `https://` origin (web) in the Spotify dashboard.
Spotify Premium is required for any playback control (`403 PREMIUM_REQUIRED`).

### 6.2 Starting playback at a position

```http
PUT https://api.spotify.com/v1/me/player/play?device_id={optional}
Authorization: Bearer …
Content-Type: application/json

{ "uris": ["spotify:track:0VjIjW4GlUZAMYd2vXMi3b"], "position_ms": 62525 }
```

`204` on success. `404 NO_ACTIVE_DEVICE` means no Spotify client is running — the UI tells the user to
open Spotify and press play once (or pick a device via `GET /me/player/devices` + `PUT /me/player`
transfer). A `position_ms` beyond the track length makes Spotify skip to the next song, so
`computeTargetPosition` refuses when fewer than 1.5 s would remain.

### 6.3 Reading the player back

`GET /me/player` returns `progress_ms`, `is_playing`, `item.uri`, `timestamp` (204 when idle). It is the
signal for start-up calibration and drift verification. `PUT /me/player/seek?position_ms=` performs the
correction and the manual ± 100 ms nudge.

---

## 7. Latency compensation — the math

### 7.1 Timeline

```
 ambient source ─────────────────────────────────────────────────────────────────▶ time
                │◀──── captureMs ────▶│                                             
 t: captureStart              captureEnd   uploadStart      responseReceived   dispatchAt   audible
                                     │◀ encode ▶│◀── upload + ACR + download ──▶│◀ decide ▶│◀ startup ▶│
 ACRCloud says: "at captureEnd the song was at R"  (R = referencePositionAtCaptureEnd)
```

Every timestamp comes from one **monotonic** clock (`performance.now()`); differences are therefore
immune to wall-clock adjustments. `captureStart` is *back-dated* from the recorder's own reported
duration, because `record()` returns 30–150 ms before the encoder really starts.

### 7.2 The formula (`core/sync/latency.ts`)

```
R              = referencePositionAtCaptureEnd(match, captureMs, anchor)        // § 5.4
elapsed        = dispatchAt − captureEnd            // encode + upload + ACR + download + decision
position_ms    = R + elapsed + startupLatencyMs + userTrimMs
```

Only `startupLatencyMs` — the time from dispatching the play request until the device emits the first
sample — cannot be measured before the fact; everything else is a clock difference. It is estimated
per device (Section 7.3). The result comes with a full `LatencyBreakdown` so the UI can show the budget.

**Worked example** (numbers from `latency.test.ts`):

| Leg | ms |
| --- | ---: |
| Recording (`captureMs`) | 6000 (not added — ACRCloud already accounts for it via R) |
| Encode + prepare (`uploadStart − captureEnd`) | 80 |
| Upload + ACRCloud + download (`responseReceived − uploadStart`) | 900 |
| Decision (`dispatchAt − responseReceived`) | 20 |
| **Elapsed since capture end** | **1000** |
| Calibrated start-up latency | 350 |
| Manual trim | −30 |
| **Total compensation** | **1320** |

With `play_offset_ms = 60 000` → `position_ms = 61 320`.

### 7.3 Start-up latency calibration (`core/sync/calibration.ts`)

We asked for position **P** at `dispatchAt`. A probe of `GET /me/player` sent at `s` and answered at
`r` (midpoint `M = (s + r)/2`, when the server most likely sampled it) reports `progress_ms = p`.
Audio has been playing for `p − P`, so it started at `M − (p − P)` and

```
startupLatency = M − (p − P) − dispatchAt
```

Measurements are folded into a per-device **exponential moving average** (α = 0.35, clamped 0–4000 ms;
the first real measurement replaces the 350 ms default outright) and persisted, so each launch starts
from the last good estimate. Implausible probes (progress before P, or a different track) are ignored.

### 7.4 Verification and drift correction (`core/sync/drift.ts`)

Calibration relies on Spotify's *reported* progress, which can be a couple of hundred ms stale. The
second pass uses the actual sound in the room instead:

```
ambientNow = ambient.position + (now − ambient.at)        // from ACRCloud, at the 2nd recording's captureEnd
playerNow  = player.position  + (now − player.at)         // from /me/player probe, at its midpoint
drift      = (ambientNow + userTrim) − playerNow           // > 0 ⇒ we are behind
if |drift| > 120 ms  → seek(ambientNow + userTrim + 0.6 × startupLatency)
if |drift| > 30 s    → the room moved to a different song; ask for a fresh sync
```

Because the play command used `before.estimateMs`, the observed drift is precisely the error of that
estimate: `trueStartup = before + drift`. That value is folded into the EMA as one more sample, so the
estimate converges on audio evidence, not just on the API's self-report. `syncSession.test.ts` shows
an untrained model with a 600 ms error landing within ±25 ms after one correction.

### 7.5 Error budget

| Source | Typical | Handled by |
| --- | ---: | --- |
| Recorder start-up (`record()` → first frame) | 30–150 ms | back-dating `captureStart` from the recorder's duration |
| ACRCloud offset granularity | ±50–100 ms | paired `db/sample` offsets; verification pass |
| Network jitter after `dispatchAt` | 50–300 ms | folded into calibration; verification |
| Spotify Connect device start-up | 150–1000 ms, device-specific | EMA calibration + drift feedback |
| `progress_ms` staleness | up to ~200 ms | verification uses the microphone, not the API |
| Bluetooth headphone latency on the listener's side | 100–250 ms (fixed per headset) | manual trim (remembered) |
| Different master (radio edit, remaster) | seconds | ISRC-first lookup + duration mismatch warning |

Target after verification: **< 100 ms**, which is below the threshold at which two copies of the same
song read as an echo.

---

## 8. Failure modes

| Situation | Behaviour |
| --- | --- |
| No match (`1001`) or low score | `no_match` result; UI asks the user to move closer. Consider extending the capture to 10 s on retry. |
| ACRCloud `3014` (bad signature) / `3003` (quota) | Typed error with the documented message; check the proxy's clock and plan limits. |
| Song identified but no Spotify id | ISRC search, then title + artist; else `no_spotify_track`. |
| Song about to end | `track_ending`; no play command (Spotify would jump to the next track). |
| No active Spotify device | `NO_ACTIVE_DEVICE` mapped to a clear instruction; optional device picker via `/me/player/devices`. |
| Not Premium | `PREMIUM_REQUIRED` surfaced verbatim. |
| Token expired | Transparent refresh; `UNAUTHORIZED` → reconnect prompt. |
| 429 | One retry honouring `Retry-After`. |
| Spotify plays through **this phone's speaker** | The verification recording would hear our own player, not the room. The UI exposes a *Verify* switch to turn the second pass off in that case; headphones or another Connect device are the intended setup. |
| Room changes song during verification | Second match has a different `acrid` → `resync` recommendation, no seek. |
| Media services reset (iOS) | Recorder must be re-prepared; `captureSample` prepares before every run. |

---

## 9. Testing

`npm test` runs 58 vitest cases in Node:

- `hmacSha1.test.ts` — SHA-1 vectors, block boundaries, HMAC vs `node:crypto`, RFC 2202.
- `signing.test.ts` — exact `string_to_sign`, signature, timestamp from the clock, local/remote signers.
- `parse.test.ts` — ranking by score, required `play_offset_ms`, ISRC / Spotify id, status codes.
- `identify.test.ts` — multipart field names, `sample_bytes`, timing stamps, non-JSON failures.
- `latency.test.ts` — the formula, anchoring, clamping, end-of-track guard.
- `calibration.test.ts` — probe-based start-up measurement, EMA, clamping.
- `drift.test.ts` — thresholds, forward/backward seeks, trim, resync.
- `spotifyClient.test.ts` — request shapes (`position_ms` body, `device_id`, `seek` query), 204/404/403/401/429 handling, ISRC search.
- `syncSession.test.ts` — a simulated room + Spotify device on a `FakeClock`: proves `position_ms` equals `R + elapsed + startup`, that calibration learns the true latency, and that the verification pass corrects a 600 ms error.

On-device (not automatable here): microphone capture, PKCE round trip, real Spotify Connect latency.
`npm run typecheck` covers the React Native layer.

---

## 10. Setup

1. **ACRCloud** — console.acrcloud.com → *Audio & Video Recognition* project → note host, access key,
   secret. Enable Spotify in the project's *3rd-party ID integration* so responses carry the track id.
2. **Spotify** — developer.spotify.com/dashboard → app → add redirect URIs `unison://spotify-auth` and
   your web origin → note the Client ID. Use a Premium account for testing.
3. `cd unison && cp .env.example .env` and fill in the values (`EXPO_PUBLIC_ACR_ACCESS_SECRET` for dev
   only; `EXPO_PUBLIC_ACR_SIGN_PROXY_URL` for prod, run `npm run acr-proxy` with the secret in env).
4. `npm install --legacy-peer-deps && npm test && npm run typecheck`.
5. `npx expo run:ios` / `npx expo run:android` (development build, so the config plugin can add the
   microphone strings) or `npx expo start --web`.

---

## 11. Production checklist & roadmap

- [ ] Attestation + rate limiting on the signing proxy.
- [ ] Device picker (`/me/player/devices`) with per-device calibration keys (`deviceId` instead of `active-device`).
- [ ] Progressive capture: try 4 s, extend to 10 s on `no_match` without restarting.
- [ ] Spotify **App Remote / iOS SDK** as an optional fast path when the target device is this phone (lower start-up latency than Web API → Connect).
- [ ] Apple Music via MusicKit (`playbackTime` seek) and YouTube Music as additional targets — the core is target-agnostic.
- [ ] Continuous mode: re-verify every 60 s; detect track changes in the room and follow them.
- [ ] Group mode: one phone identifies, others receive `{ uri, referencePosition, atWallTime }` and apply their own calibration.
- [ ] Analytics on the latency budget to tune the 350 ms default per platform/device model.

---

## 12. References

- ACRCloud Identification API: https://docs.acrcloud.com/reference/identification-api
- ACRCloud music metadata (`play_offset_ms`, offsets): https://docs.acrcloud.com/metadata/music
- Spotify — Start/Resume Playback (`position_ms`): https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback
- Spotify — Get Playback State: https://developer.spotify.com/documentation/web-api/reference/get-information-about-the-users-current-playback
- Spotify — Seek To Position: https://developer.spotify.com/documentation/web-api/reference/seek-to-position-in-currently-playing-track
- Spotify — PKCE flow: https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
- Expo Audio (`expo-audio`): https://docs.expo.dev/versions/latest/sdk/audio/
- Expo AuthSession (Spotify example): https://docs.expo.dev/guides/authentication/#spotify
