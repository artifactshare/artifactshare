import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { prepareUploadPayload } from './files.js'
import { readUploadBoundary } from './upload-boundary.js'

vi.mock('./upload-boundary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./upload-boundary.js')>()),
  readUploadBoundary: vi.fn(),
}))

test('upload forms release snapshot buffers and retain reusable immutable content', async () => {
  const snapshot = {
    directory: true,
    files: [
      {
        path: 'site/index.html',
        relativePath: 'index.html',
        bytes: Buffer.from('<p>selected</p>'),
      },
      {
        path: 'site/style.css',
        relativePath: 'style.css',
        bytes: Buffer.from('p { color: red; }'),
      },
    ],
  }
  vi.mocked(readUploadBoundary).mockResolvedValueOnce(snapshot)
  const result = await prepareUploadPayload('site')
  assert.ok(result.payload)
  assert.equal(result.payload.kind, 'static_site')
  assert.deepEqual(
    snapshot.files.map((file) => file.bytes.length),
    [0, 0],
  )
  const parts = result.payload.form.getAll('file')
  for (let retry = 0; retry < 2; retry++) {
    const content = await Promise.all(
      parts.map(async (part) => {
        assert.notEqual(typeof part, 'string')
        if (typeof part === 'string') throw new Error('Expected upload file')
        return [part.name, part.type, await part.text()]
      }),
    )
    assert.deepEqual(content, [
      ['index.html', 'text/html', '<p>selected</p>'],
      ['style.css', 'text/css', 'p { color: red; }'],
    ])
  }
  assert.equal(vi.mocked(readUploadBoundary).mock.calls.length, 1)
})
