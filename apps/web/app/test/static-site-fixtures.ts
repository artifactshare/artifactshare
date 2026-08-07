import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export interface StaticSiteFixtureFile {
  path: string
  body: Uint8Array
  mimeType: string
}

const FIXTURE_ROOT = path.resolve(
  import.meta.dirname,
  '../../../../fixtures/static-sites',
)

export async function loadStaticSiteFixture(
  name: string,
): Promise<StaticSiteFixtureFile[]> {
  const root = path.join(FIXTURE_ROOT, name)
  const files = await listFiles(root)
  return await Promise.all(
    files.map(async (absolutePath) => {
      const relativePath = path
        .relative(root, absolutePath)
        .split(path.sep)
        .join('/')
      return {
        path: `/${relativePath}`,
        body: await readFile(absolutePath),
        mimeType: mimeTypeForPath(relativePath),
      }
    }),
  )
}

export async function loadStaticSiteFixtureFiles(
  name: string,
): Promise<File[]> {
  const fixture = await loadStaticSiteFixture(name)
  return fixture.map(
    (file) =>
      new File([arrayBufferFromBytes(file.body)], file.path.slice(1), {
        type: file.mimeType,
      }),
  )
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(root, entry.name)
      if (entry.isDirectory()) return await listFiles(absolutePath)
      if (entry.name === '.DS_Store') return []
      if (entry.isFile()) return [absolutePath]
      return []
    }),
  )
  return nested.flat().sort()
}

function mimeTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase()
  switch (extension) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.data':
      return 'application/octet-stream'
    case '.rsc':
      return 'text/x-component; charset=utf-8'
    case '.meta':
      return 'text/plain; charset=utf-8'
    default:
      return 'text/plain; charset=utf-8'
  }
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
}
