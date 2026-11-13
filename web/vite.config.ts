import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

// Each build has an id, compiled in and written to version.json, so that
// an installed page can tell a newer build is on the server
// (src/lib/update.ts).
const build = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

// `pnpm dev` serves the interface and passes /api on to a nuthatch
// server on this machine (dev/nuthatch.toml listens there).
export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'nuthatch-version',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify({ build })}\n` })
      },
    },
  ],
  define: { __NUTHATCH_BUILD__: JSON.stringify(build) },
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
