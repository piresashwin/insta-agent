import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        // Lesson 10 SSE — don't buffer or kill long-lived event streams.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.url?.includes('/events')) {
              proxyReq.setHeader('Accept', 'text/event-stream')
            }
          })
        },
      },
      // Same-origin assets so canvas bake is not CORS-tainted.
      '/assets': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
})
