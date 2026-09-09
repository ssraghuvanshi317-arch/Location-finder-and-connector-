import { useAudioRecorder } from 'expo-audio';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { config, configProblems } from '../config';
import { localSigner, remoteSigner, type AcrSigner } from '../core/acrcloud/signing';
import { sleep, systemClock } from '../core/clock';
import { SpotifyClient, userFacingSpotifyMessage } from '../core/spotify/client';
import { DEFAULT_SYNC_OPTIONS, SyncSession, formatMs, type SyncEvent, type SyncResult } from '../orchestrator/syncSession';
import { identifyWithPlatformUpload } from '../services/acrcloudService';
import { SYNC_RECORDING_OPTIONS, captureSample, ensureMicrophonePermission } from '../services/recorder';
import { useSpotifyAuth } from '../services/spotifyAuth';
import { calibrationStore } from '../services/storage';

const CALIBRATION_KEY = `${Platform.OS}.active-device`;
const NUDGE_MS = 100;

export function SyncScreen() {
  const recorder = useAudioRecorder(SYNC_RECORDING_OPTIONS);
  const auth = useSpotifyAuth(config.spotify.clientId);

  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<SyncEvent[]>([]);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState(true);
  const [userTrimMs, setUserTrimMs] = useState(0);
  const sessionRef = useRef<SyncSession | null>(null);

  const spotify = useMemo(
    () => new SpotifyClient({ getAccessToken: auth.getAccessToken, clock: systemClock }),
    [auth.getAccessToken],
  );

  const signer = useMemo<AcrSigner>(() => {
    if (config.acr.signProxyUrl) return remoteSigner(config.acr.signProxyUrl);
    return localSigner(config.acr.accessKey, config.acr.accessSecret ?? '', systemClock);
  }, []);

  const problems = configProblems();

  const runSync = useCallback(async () => {
    setError(null);
    setResult(null);
    setEvents([]);
    setBusy(true);
    try {
      if (!(await ensureMicrophonePermission())) throw new Error('Microphone permission denied');

      const session = new SyncSession(
        {
          clock: systemClock,
          sleep,
          capture: (ms) => captureSample(recorder, ms, systemClock),
          signer,
          identify: (sample, signedFields) =>
            identifyWithPlatformUpload({ host: config.acr.host, sample, signedFields, clock: systemClock, minScore: config.sync.minScore }),
          spotify,
          loadCalibration: () => calibrationStore.load(CALIBRATION_KEY),
          saveCalibration: (model) => calibrationStore.save(CALIBRATION_KEY, model),
        },
        {
          ...DEFAULT_SYNC_OPTIONS,
          captureMs: config.sync.captureMs,
          verifyCaptureMs: config.sync.verifyCaptureMs,
          verifyDelayMs: config.sync.verifyDelayMs,
          minScore: config.sync.minScore,
          driftThresholdMs: config.sync.driftThresholdMs,
          anchor: config.sync.anchor,
          verify,
          userTrimMs,
        },
        (event) => setEvents((prev) => [...prev, event]),
      );
      sessionRef.current = session;
      setResult(await session.run());
    } catch (err) {
      setError(userFacingSpotifyMessage(err));
    } finally {
      sessionRef.current = null;
      setBusy(false);
    }
  }, [recorder, signer, spotify, verify, userTrimMs]);

  /** Manual ±100 ms nudge: seeks the live player and remembers the trim for the next sync. */
  const nudge = useCallback(
    async (deltaMs: number) => {
      try {
        const probe = await spotify.getPlaybackState();
        if (!probe.state || probe.state.progress_ms === null) throw new Error('Nothing is playing');
        const inFlight = (probe.ackAt - probe.dispatchAt) / 2; // progress was sampled mid-request
        await spotify.seek(probe.state.progress_ms + inFlight + deltaMs);
        setUserTrimMs((t) => t + deltaMs);
      } catch (err) {
        setError(userFacingSpotifyMessage(err));
      }
    },
    [spotify],
  );

  const success = result?.status === 'synced' ? result : null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Unison</Text>
      <Text style={styles.subtitle}>Hear what the room hears — on your Spotify, in time.</Text>

      {problems.length > 0 && (
        <View style={[styles.card, styles.warn]}>
          {problems.map((p) => (
            <Text key={p} style={styles.warnText}>
              • {p}
            </Text>
          ))}
        </View>
      )}

      <View style={styles.card}>
        <Row label="Spotify" value={auth.isConnected ? 'Connected' : 'Not connected'} />
        {auth.error && <Text style={styles.errorText}>{auth.error}</Text>}
        <View style={styles.buttonRow}>
          <Button
            label={auth.isConnected ? 'Disconnect' : 'Connect Spotify'}
            onPress={auth.isConnected ? auth.disconnect : auth.connect}
            disabled={!auth.ready || busy}
          />
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.switchRow}>
          <Text style={styles.label}>Verify & auto-correct (turn off if Spotify plays through this phone's speaker)</Text>
          <Switch value={verify} onValueChange={setVerify} disabled={busy} />
        </View>
        <Row label="Manual trim" value={`${userTrimMs > 0 ? '+' : ''}${userTrimMs} ms`} />
        <View style={styles.buttonRow}>
          <Button label={busy ? 'Working…' : 'Listen & Sync'} onPress={runSync} disabled={busy || !auth.isConnected} primary />
          <Button label="Stop" onPress={() => sessionRef.current?.abort()} disabled={!busy} />
        </View>
        <View style={styles.buttonRow}>
          <Button label={`− ${NUDGE_MS} ms`} onPress={() => nudge(-NUDGE_MS)} disabled={busy || !success} />
          <Button label={`+ ${NUDGE_MS} ms`} onPress={() => nudge(NUDGE_MS)} disabled={busy || !success} />
        </View>
      </View>

      {busy && (
        <View style={styles.busyRow}>
          <ActivityIndicator color="#1db954" />
          <Text style={styles.busyText}>{events[events.length - 1]?.message ?? 'Starting…'}</Text>
        </View>
      )}

      {error && (
        <View style={[styles.card, styles.warn]}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {success && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{success.trackLabel}</Text>
          <Row label="Started at" value={formatMs(success.target.positionMs)} />
          <Row label="Ambient at capture end" value={formatMs(success.target.referencePositionAtCaptureEndMs)} />
          <Row label="Anchor" value={success.target.breakdown.anchorUsed} />
          <Text style={styles.sectionTitle}>Latency budget</Text>
          <Row label="Recording" value={`${Math.round(success.target.breakdown.captureMs)} ms`} />
          <Row label="Encode + prepare" value={`${Math.round(success.target.breakdown.encodeAndPrepareMs)} ms`} />
          <Row
            label="Upload + ACRCloud + download"
            value={`${Math.round(success.target.breakdown.networkRoundTripMs)} ms${
              success.target.breakdown.acrProcessingMs !== undefined ? ` (ACR ${success.target.breakdown.acrProcessingMs} ms)` : ''
            }`}
          />
          <Row label="Decision" value={`${Math.round(success.target.breakdown.decisionMs)} ms`} />
          <Row label="Device startup (calibrated)" value={`${success.target.breakdown.startupLatencyMs} ms`} />
          <Row label="Manual trim" value={`${success.target.breakdown.userTrimMs} ms`} />
          <Row label="Total added" value={`${Math.round(success.target.breakdown.totalCompensationMs)} ms`} bold />
          <Text style={styles.sectionTitle}>Calibration</Text>
          <Row
            label="Startup latency"
            value={`${success.calibration.before.estimateMs} → ${success.calibration.after.estimateMs} ms (${success.calibration.after.samples} samples)`}
          />
          {success.calibration.measuredMs !== null && <Row label="Measured this run" value={`${success.calibration.measuredMs} ms`} />}
          {success.verification && (
            <>
              <Text style={styles.sectionTitle}>Verification</Text>
              <Row label="Drift" value={`${success.verification.decision.driftMs > 0 ? '+' : ''}${success.verification.decision.driftMs} ms`} />
              <Row label="Action" value={success.verification.decision.action} />
              {success.verification.seekedToMs !== undefined && <Row label="Seeked to" value={formatMs(success.verification.seekedToMs)} />}
            </>
          )}
        </View>
      )}

      {result && result.status !== 'synced' && (
        <View style={[styles.card, styles.warn]}>
          <Text style={styles.warnText}>
            {result.status === 'no_match' && 'No match — move closer to the speaker and try again.'}
            {result.status === 'no_spotify_track' && 'Recognised the song, but it is not available on Spotify.'}
            {result.status === 'track_ending' && 'The song is about to end; try again when the next one starts.'}
            {result.status === 'aborted' && 'Stopped.'}
          </Text>
        </View>
      )}

      {events.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Log</Text>
          {events.map((e, i) => (
            <Text key={`${e.at}-${i}`} style={styles.logLine}>
              <Text style={styles.logPhase}>{e.phase.padEnd(12)}</Text> {e.message}
            </Text>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, bold && styles.bold]}>{value}</Text>
    </View>
  );
}

function Button({ label, onPress, disabled, primary }: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.button, primary && styles.buttonPrimary, disabled && styles.buttonDisabled, pressed && styles.buttonPressed]}
    >
      <Text style={[styles.buttonText, primary && styles.buttonTextPrimary]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b0f14' },
  content: { padding: 20, gap: 14, paddingBottom: 60 },
  title: { color: '#ffffff', fontSize: 34, fontWeight: '700' },
  subtitle: { color: '#9aa4b2', fontSize: 15, marginBottom: 6 },
  card: { backgroundColor: '#141a22', borderRadius: 14, padding: 16, gap: 8 },
  cardTitle: { color: '#ffffff', fontSize: 17, fontWeight: '600', marginBottom: 4 },
  sectionTitle: { color: '#1db954', fontSize: 13, fontWeight: '700', marginTop: 10, textTransform: 'uppercase', letterSpacing: 0.6 },
  warn: { backgroundColor: '#2a1f14', borderColor: '#8a5a1e', borderWidth: 1 },
  warnText: { color: '#f5c283', fontSize: 14 },
  errorText: { color: '#ff7b7b', fontSize: 14 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  label: { color: '#9aa4b2', fontSize: 14, flexShrink: 1 },
  value: { color: '#e6edf3', fontSize: 14, fontVariant: ['tabular-nums'] },
  bold: { fontWeight: '700', color: '#ffffff' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 6 },
  button: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center', backgroundColor: '#243040' },
  buttonPrimary: { backgroundColor: '#1db954' },
  buttonDisabled: { opacity: 0.4 },
  buttonPressed: { opacity: 0.75 },
  buttonText: { color: '#e6edf3', fontWeight: '600', fontSize: 15 },
  buttonTextPrimary: { color: '#062b14' },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  busyText: { color: '#e6edf3', fontSize: 14, flexShrink: 1 },
  logLine: { color: '#c4ccd6', fontSize: 12, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) },
  logPhase: { color: '#1db954' },
});
