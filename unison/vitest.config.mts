import { defineConfig } from 'vitest/config';

// Only the pure-TypeScript core is unit tested in Node. Everything that touches
// expo-audio / expo-auth-session / React Native is exercised on-device.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
