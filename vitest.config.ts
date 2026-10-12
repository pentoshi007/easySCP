import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __VERSION__: JSON.stringify('0.0.0-test') },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    unstubEnvs: true,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
