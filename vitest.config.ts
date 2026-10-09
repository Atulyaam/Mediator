import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@mediator/shared-contracts': resolve(__dirname, 'packages/shared-contracts/src/index.ts'),
      '@mediator/task-domain': resolve(__dirname, 'packages/task-domain/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules', 'dist', '**/*.test.ts', '**/*.d.ts'],
    },
    reporters: ['verbose'],
  },
});
