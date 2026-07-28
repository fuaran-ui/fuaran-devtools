import { defineConfig } from 'vitest/config';

// One suite. The DOM-touching modules (overlay, picker, detection) need a
// document, and the rest do not care, so jsdom everywhere keeps the config to
// a single line rather than a glob table.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
  },
});
