import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['test/**/*.test.mjs', 'src/**/*.test.mjs'], environment: 'node' },
});
