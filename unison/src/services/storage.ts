import AsyncStorage from '@react-native-async-storage/async-storage';

import type { StartupLatencyModel } from '../core/sync/calibration';

const CALIBRATION_PREFIX = 'unison.calibration.';

/** Persist the per-device startup-latency model so every launch starts from the last good estimate. */
export const calibrationStore = {
  async load(deviceKey: string): Promise<StartupLatencyModel | null> {
    try {
      const raw = await AsyncStorage.getItem(CALIBRATION_PREFIX + deviceKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<StartupLatencyModel>;
      if (typeof parsed.estimateMs !== 'number' || typeof parsed.samples !== 'number') return null;
      return parsed as StartupLatencyModel;
    } catch {
      return null;
    }
  },

  async save(deviceKey: string, model: StartupLatencyModel): Promise<void> {
    await AsyncStorage.setItem(CALIBRATION_PREFIX + deviceKey, JSON.stringify(model));
  },

  async clear(deviceKey: string): Promise<void> {
    await AsyncStorage.removeItem(CALIBRATION_PREFIX + deviceKey);
  },
};
