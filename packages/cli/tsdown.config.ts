import { defineConfig } from 'tsdown'

export default defineConfig({
  deps: { alwaysBundle: [/^@artifactshare\/viewer-kit\//] },
  clean: true,
  dts: true,
  entry: ['src/index.ts', 'src/cursor-acp-entry.ts'],
  format: ['esm'],
  outExtensions: () => ({ js: '.js' }),
  platform: 'node',
})
