import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the real `vscode` module to our test stand-in so unit
      // tests can import any project file (including coordinators that
      // depend on the VSCode API) without launching VSCode itself.
      vscode: path.resolve(__dirname, 'test/__mocks__/vscode.ts'),
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
