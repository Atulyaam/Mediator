import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@mediator/shared-contracts': resolve(__dirname, 'packages/shared-contracts/src/index.ts'),
      '@mediator/task-domain': resolve(__dirname, 'packages/task-domain/src/index.ts'),
      '@mediator/workspace-boundary': resolve(__dirname, 'packages/workspace-boundary/src/index.ts'),
      '@mediator/context-security': resolve(__dirname, 'packages/context-security/src/index.ts'),
      '@mediator/policy-engine': resolve(__dirname, 'packages/policy-engine/src/index.ts'),
      '@mediator/protocol': resolve(__dirname, 'packages/protocol/src/index.ts'),
      '@mediator/content-transfer': resolve(__dirname, 'packages/content-transfer/src/index.ts'),
      '@mediator/persistence': resolve(__dirname, 'packages/persistence/src/index.ts'),
      '@mediator/context-engine': resolve(__dirname, 'packages/context-engine/src/index.ts'),
      '@mediator/stage-store': resolve(__dirname, 'packages/stage-store/src/index.ts'),
      '@mediator/staging-store': resolve(__dirname, 'packages/stage-store/src/index.ts'),
      '@mediator/ide-adapter-vscode': resolve(__dirname, 'packages/ide-adapter-vscode/src/index.ts'),
      '@mediator/ide-adapter-antigravity': resolve(__dirname, 'packages/ide-adapter-antigravity/src/index.ts'),
      '@mediator/mcp-server': resolve(__dirname, 'packages/mcp-server/src/index.ts'),
      '@mediator/ipc-core': resolve(__dirname, 'packages/ipc-core/src/index.ts'),
      '@mediator/native-host': resolve(__dirname, 'packages/native-host/src/index.ts'),
      '@mediator/executor-contract': resolve(__dirname, 'packages/executor-contract/src/index.ts'),
      '@mediator/recipe-registry': resolve(__dirname, 'packages/recipe-registry/src/index.ts'),
      '@mediator/orchestrator': resolve(__dirname, 'packages/orchestrator/src/index.ts'),
      '@mediator/provider-core': resolve(__dirname, 'packages/provider-core/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules', 'dist', '**/*.test.ts', '**/*.d.ts'],
    },
    reporters: ['verbose'],
  },
});
