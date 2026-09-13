const options = {
  clean: true,
  dts: true,
  entry: ['src/index.ts'],
  format: ['esm'],
  outExtensions: () => ({ js: '.js' }),
  platform: 'neutral',
}

export default options
