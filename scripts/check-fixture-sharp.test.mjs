import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

// Resolve exactly the optional native dependency used by the fixture's Next.
test('fixture Next Sharp performs a native PNG resize and decode', async () => {
  let sharp
  try {
    const fixtureRequire = createRequire(
      new URL('../tools/static-site-fixtures/package.json', import.meta.url),
    )
    const nextRequire = createRequire(
      fixtureRequire.resolve('next/package.json'),
    )
    sharp = nextRequire('sharp')
  } catch (cause) {
    throw new Error(
      'Cannot load fixture Next optional Sharp dependency; install frozen dependencies including optional native packages for this platform.',
      { cause },
    )
  }
  const pixel = [32, 64, 128]
  const input = Buffer.from(Array.from({ length: 16 }, () => pixel).flat())
  const png = await sharp(input, { raw: { width: 4, height: 4, channels: 3 } })
    .resize(2, 2)
    .png()
    .toBuffer()
  const metadata = await sharp(png).metadata()
  assert.equal(metadata.format, 'png')
  assert.equal(metadata.width, 2)
  assert.equal(metadata.height, 2)
  assert.equal(metadata.channels, 3)
  const { data, info } = await sharp(png)
    .raw()
    .toBuffer({ resolveWithObject: true })
  assert.equal(info.width, 2)
  assert.equal(info.height, 2)
  assert.equal(info.channels, 3)
  assert.deepEqual(
    data,
    Buffer.from(Array.from({ length: 4 }, () => pixel).flat()),
  )
})
