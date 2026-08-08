import { reactRouter } from '@react-router/dev/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    cloudflare({
      configPath: process.env.WRANGLER_CONFIG_PATH ?? 'wrangler.jsonc',
      remoteBindings: false,
      viteEnvironment: { name: 'ssr' },
    }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: { tsconfigPaths: true },
})
