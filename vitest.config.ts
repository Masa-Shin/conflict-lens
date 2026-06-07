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
    // Several suites are integration-style: they create a temp repo and
    // spawn real git processes. Spawning is markedly slower on the Windows
    // CI runner, where the default 5s budget intermittently times out.
    // Give those git-backed tests (and their setup hooks) generous room.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
