import { expect, test } from 'vitest'
import { splitAssetRef } from './asset-ref'

test('splitAssetRef preserves query and hash suffixes', () => {
  expect(splitAssetRef('/a.css?v=1#frag')).toEqual({
    pathname: '/a.css',
    suffix: '?v=1#frag',
  })
})
