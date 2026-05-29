import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api':       'http://localhost:8000',
      '/admin':     'http://localhost:8000',
      '/enroll':    'http://localhost:8000',
      '/telemetry': 'http://localhost:8000',
      '/health':    'http://localhost:8000',
    },
  },
  build: {
    outDir: '../src/aiops_server/dashboard',
    emptyOutDir: true,
  },
})
