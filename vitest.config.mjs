import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'test/**/*.test.mjs', 'src/**/*.test.mjs', 'bin/**/*.test.mjs', 'bench/**/*.test.mjs',
    ],
    environment: 'node',
    setupFiles: ['./test/setup.mjs'],
  },
});
