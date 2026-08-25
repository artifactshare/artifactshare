const shared = {
  dts: true,
  format: ['esm'],
  outExtensions: () => ({ js: '.js' }),
} as const

export default [
  {
    ...shared,
    clean: true,
    entry: ['src/index.ts', 'src/client.ts', 'src/qm.ts', 'src/testing.ts'],
    platform: 'neutral',
  },
  {
    ...shared,
    clean: false,
    entry: ['src/cli.ts'],
    platform: 'node',
  },
] as const
