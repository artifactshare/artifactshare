import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  readContentDeliveryStage,
  verifyContentCutover,
} from './verify-content-cutover.mjs'

function deploy(args) {
  const result = spawnSync('pnpm', ['exec', 'wrangler', 'deploy', ...args], {
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_LOG_PATH: '../../.wrangler/logs' },
  })
  if (result.error || result.status !== 0)
    throw new Error('Content deployment failed')
}

/** Called only by the protected production workflow, after builds and migration. */
export async function deployContentCutover({
  readStage = readContentDeliveryStage,
  verify = verifyContentCutover,
  run = deploy,
  log = console.info,
} = {}) {
  const stage = await readStage()
  log('Content deployment path', {
    path: stage === 'usercontent' ? 'steady-state' : 'transition',
  })
  if (stage !== 'usercontent') {
    await run(['--var', 'ARTIFACT_DELIVERY_STAGE:refuse'])
    await verify('app-refusal')
  }
  await run(['-c', 'wrangler.sandbox.jsonc', '--env', 'production'])
  await verify('sandbox-ready')
  await run(['--var', 'ARTIFACT_DELIVERY_STAGE:usercontent'])
  await verify('sandbox-ready')
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await deployContentCutover()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
