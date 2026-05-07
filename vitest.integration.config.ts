import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

// Separate config for integration tests — these hit live network endpoints
// (Nostr relays) and are excluded from the default `vitest run`. Run with:
//   npm run test:integration
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
