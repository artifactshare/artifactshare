import { expect, test } from 'vitest'
import { loadStaticSiteFixture } from './static-site-fixtures'

test('a missing fixture names itself and the command that builds it', async () => {
  // Assert the two things a reader needs, not the path separators between
  // them, so this holds wherever the checkout lives.
  await expect(loadStaticSiteFixture('not-a-fixture')).rejects.toThrow(
    'Static site fixture "not-a-fixture" is missing at',
  )
  await expect(loadStaticSiteFixture('not-a-fixture')).rejects.toThrow(
    'Run `pnpm fixtures:build`',
  )
  // The original error stays reachable, so a failure that only looks like a
  // missing fixture is still diagnosable.
  await expect(loadStaticSiteFixture('not-a-fixture')).rejects.toMatchObject({
    cause: { code: 'ENOENT' },
  })
})
