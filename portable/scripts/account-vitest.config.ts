import { defineConfig } from '../../d/node_modules/vitest/dist/config.js'
import tsconfigPaths from '../../d/node_modules/vite-tsconfig-paths/dist/index.js'
import { standardDecoratorPlugin, vitestExecArgv } from '../../d/vitest.shared.ts'

export default defineConfig({
  plugins: [standardDecoratorPlugin(), tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: ['packages/sandbox/sandbox-local/tests/account-mode.spec.ts'],
    pool: 'forks', execArgv: vitestExecArgv, testTimeout: 30000,
  },
})
