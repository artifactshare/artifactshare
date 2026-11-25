import { afterEach, expect, test, vi } from 'vitest'
import { writeSuccess } from './output.js'

afterEach(() => {
  vi.restoreAllMocks()
})

test('human share output repeats the visibility hint the server sent', () => {
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
  const output = String(write.mock.calls[0]![0])
  expect(output).toContain('Visibility: private')
  expect(output).toContain('Home defaults to private.')
})
