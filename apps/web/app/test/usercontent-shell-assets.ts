import assert from 'node:assert/strict'

// Include inline module imports as well as script/link attributes. React Router
// puts route chunks in its inline manifest, so checking only src misses them.
export async function assertShellAssets(
  shellUrl: string,
  fetchResponse: (
    url: string,
  ) => Promise<Pick<Response, 'status' | 'text' | 'arrayBuffer'>>,
): Promise<void> {
  const shell = await fetchResponse(shellUrl)
  assert.equal(shell.status, 200, `Usercontent shell preflight: ${shellUrl}`)
  const html = await shell.text()
  const assets = new Set(
    Array.from(
      html.matchAll(/["'](\/assets\/[^"'\s<>]+)["']/g),
      (match) => new URL(match[1], shellUrl).href,
    ),
  )
  assert.ok(
    assets.size > 0,
    `Usercontent shell preflight: no assets in ${shellUrl}`,
  )
  for (const url of assets) {
    const response = await fetchResponse(url)
    await response.arrayBuffer()
    assert.equal(
      response.status,
      200,
      `Usercontent shell preflight: ${url} returned ${response.status}; the harness build must contain every asset referenced by its shell`,
    )
  }
}
