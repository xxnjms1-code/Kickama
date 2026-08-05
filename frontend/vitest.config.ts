import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest configuration. Kept separate from vite.config.ts so the production
// build (`tsc -b && vite build`) is unaffected by test-only settings.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@components': path.resolve(__dirname, './src/components'),
      '@pages': path.resolve(__dirname, './src/pages'),
      '@store': path.resolve(__dirname, './src/store'),
      '@types': path.resolve(__dirname, './src/types'),
      '@hooks': path.resolve(__dirname, './src/hooks'),
    },
  },
  test: {
    // jsdom provides localStorage, BroadcastChannel, window and atob which the
    // auth service relies on.
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    globals: false,
    clearMocks: true,
    restoreMocks: true,
  },
});
