import { spawnSync } from 'node:child_process'
const options = { size: 100000, warmup: 3, samples: 10 }
const args = process.argv.slice(2)
while (args.length) {
  const flag = args.shift()?.replace(/^--/, '')
  const value = Number(args.shift())
  if (
    !Object.hasOwn(options, flag) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > (flag === 'size' ? 100000 : 100)
  )
    throw new Error('Use --size 1..100000 --warmup 1..100 --samples 1..100')
  options[flag] = value
}
for (const command of [
  ['build'],
  [
    '--filter',
    '@artifactshare/web',
    'integration:test:run',
    '-t',
    'workspace search benchmark smoke',
  ],
]) {
  const child = spawnSync('pnpm', command, {
    stdio: 'inherit',
    env: {
      ...process.env,
      PUBLIC_INTEGRATION: '1',
      SEARCH_BENCHMARK_SIZE: String(options.size),
      SEARCH_BENCHMARK_WARMUP: String(options.warmup),
      SEARCH_BENCHMARK_SAMPLES: String(options.samples),
    },
  })
  if (child.error) throw child.error
  if (child.status !== 0) process.exit(child.status ?? 1)
}
