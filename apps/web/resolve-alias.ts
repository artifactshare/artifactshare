import { fileURLToPath } from 'node:url'

export const resolveAlias = {
  '~': fileURLToPath(new URL('./app', import.meta.url)),
  '@artifactshare/contract': fileURLToPath(
    new URL('../../packages/contract/src/index.ts', import.meta.url),
  ),
}
