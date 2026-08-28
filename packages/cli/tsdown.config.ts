import { defineConfig } from 'tsdown'

export default defineConfig({
  deps: { alwaysBundle: [/^@artifactshare\/viewer-kit\//] },
  clean: true,
  dts: true,
  entry: ['src/index.ts'],
  format: ['esm'],
  outExtensions: () => ({ js: '.js' }),
  platform: 'node',
})
