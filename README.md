# Unison — hear the room's music on your own Spotify, in time

Unison listens to the music playing around you for a few seconds, identifies the song and the exact
position it is at (ACRCloud), then starts the same track on your Spotify account at that position —
plus every millisecond of delay that piled up while it was listening, uploading and waiting.

| Part | Where |
| --- | --- |
| **Project blueprint** (architecture, latency math, API contracts, roadmap) | [`BLUEPRINT.md`](BLUEPRINT.md) |
| **Expo / React Native app** (iOS, Android, web) | [`unison/`](unison/) |
| Pure-TypeScript core: signing, parsing, latency compensation, calibration, drift | [`unison/src/core/`](unison/src/core/) |
| End-to-end pipeline (dependency-injected, unit tested) | [`unison/src/orchestrator/syncSession.ts`](unison/src/orchestrator/syncSession.ts) |
| Signing proxy so the ACRCloud secret never ships in the app | [`server/acr-sign-proxy.mjs`](server/acr-sign-proxy.mjs) |

## Quick start

```bash
cd unison
cp .env.example .env            # fill in ACRCloud + Spotify credentials
npm install --legacy-peer-deps
npm test                        # pure core: HMAC, signing, parsing, sync math, orchestrator
npm run typecheck
npx expo start                  # then press i / a / w, or scan with a development build
```

The microphone and Spotify Connect need a real device. Use `npx expo run:ios` / `run:android`
(development build) rather than Expo Go so the `expo-audio` config plugin can add the microphone
permission strings.

## How the sync works in one paragraph

Record ~6 s → POST to ACRCloud `/v1/identify` → response carries `play_offset_ms` (where the reference
track was at the end of the sample) → compute
`position_ms = play_offset_ms + (time since the recording stopped) + (calibrated device start-up latency) + (manual trim)`
→ `PUT /v1/me/player/play { uris: [uri], position_ms }` → poll `GET /v1/me/player` to measure how long the
device really took to start and update the calibration → record again, identify again, and issue one
corrective `seek` if the room and the player disagree by more than 120 ms.

See `BLUEPRINT.md` for the full timeline diagram, failure modes and the production checklist.
