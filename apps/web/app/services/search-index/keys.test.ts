import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { searchTextKey } from './keys'

test('keeps extraction keys within unambiguous workspace/shareable/version prefixes', async () => {
  expect(
    await searchTextKey('workspace', 'artifact', 'version', '/sub/日本.md'),
  ).toBe(
    'search-text/workspace/artifact/version/' +
      createHash('sha256').update('/sub/日本.md').digest('hex'),
  )
  expect(await searchTextKey('a/b', 'artifact', 'version', '/index.html')).toBe(
    'search-text/a%2Fb/artifact/version/' +
      createHash('sha256').update('/index.html').digest('hex'),
  )
  for (const path of ['/../secret', '/a/../secret', '/a//b', '/./b'])
    await expect(
      searchTextKey('workspace', 'artifact', 'version', path),
    ).rejects.toThrow('invalid_search_path')
})
