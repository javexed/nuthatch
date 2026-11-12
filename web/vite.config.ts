import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

// `pnpm dev` serves the interface and passes /api on to a nuthatch
// server on this machine (dev/nuthatch.toml listens there).
export default defineConfig({
  plugins: [vue()],
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
  test: { environment: 'node' },
})
