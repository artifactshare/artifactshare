import { reactRouter } from '@react-router/dev/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [reactRouter(), tailwindcss()],
  // Keep prerender requests and the preview listener on the same loopback address.
  preview: { host: '127.0.0.1' },
})
