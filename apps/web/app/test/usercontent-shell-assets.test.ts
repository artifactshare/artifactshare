import { expect, test, vi } from 'vitest'
import { assertShellAssets } from './usercontent-shell-assets'

const shellUrl = 'https://app.example/a/fixture'
const html = `<link href="/assets/root.css" rel="stylesheet">
<script type="module">import "/assets/entry.js";
window.manifest={"route":"/assets/viewer.js"}</script>
<script src="/assets/entry.js"></script>`

test('checks stylesheet, entry and inline route assets once before navigation', async () => {
  const fetchResponse = vi.fn(
    async (url: string) => new Response(url === shellUrl ? html : 'asset'),
  )
  await assertShellAssets(shellUrl, fetchResponse)
  expect(fetchResponse.mock.calls.map(([url]) => url)).toEqual([
    shellUrl,
    'https://app.example/assets/root.css',
    'https://app.example/assets/entry.js',
    'https://app.example/assets/viewer.js',
  ])
})

test('fails with the missing hashed asset instead of waiting for hydration', async () => {
  await expect(
    assertShellAssets(
      shellUrl,
      async (url) =>
        new Response(url === shellUrl ? html : '', {
          status: url.endsWith('/viewer.js') ? 404 : 200,
        }),
    ),
  ).rejects.toThrow('https://app.example/assets/viewer.js returned 404')
})

test('rejects failed shells and shells without client assets', async () => {
  await expect(
    assertShellAssets(shellUrl, async () => new Response('', { status: 500 })),
  ).rejects.toThrow('Usercontent shell preflight')
  await expect(
    assertShellAssets(shellUrl, async () => new Response('<h1>Error</h1>')),
  ).rejects.toThrow('no assets')
})
