import { afterEach, expect, test, vi } from 'vitest'
import { writeSuccess } from './output.js'

afterEach(() => {
  vi.restoreAllMocks()
})

test('human share output includes the private-default note', () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  writeSuccess(
    'share',
    {
      artifact: { id: 'abc123def4', url: 'https://artifactshare.test/a/abc' },
      destination: { type: 'home' },
      share: {
        visibility: 'private',
        visibility_source: 'product_default_private',
        visibility_hint: 'Home defaults to private.',
      },
    },
    { json: false },
  )
  expect(String(write.mock.calls[0]![0])).toContain(
    'Visibility: private\nNote: Home defaults to private.\n',
  )
})
