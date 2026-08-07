import { describe, expect, test } from 'vitest'
import { filesFromDrop } from './upload-drop-items'

describe('filesFromDrop', () => {
  test('falls back to dataTransfer.files when entries are unavailable', async () => {
    const file = new File(['x'], 'index.html')
    const result = await filesFromDrop({
      files: [file],
      items: [],
    } as unknown as DataTransfer)

    expect(result).toEqual([file])
  })

  test('expands dropped directories and preserves relative paths', async () => {
    const result = await filesFromDrop({
      files: [],
      items: [
        {
          webkitGetAsEntry: () =>
            directory('/site', [
              fileEntry('/site/index.html', new File(['x'], 'index.html')),
              directory('/site/assets', [
                fileEntry('/site/assets/app.js', new File(['x'], 'app.js')),
              ]),
            ]),
        },
      ],
    } as unknown as DataTransfer)

    expect(result.map((file) => file.name)).toEqual(['index.html', 'app.js'])
    expect(result.map((file) => webkitRelativePath(file))).toEqual([
      'site/index.html',
      'site/assets/app.js',
    ])
  })

  test('drains every directory reader batch', async () => {
    const result = await filesFromDrop({
      files: [],
      items: [
        {
          webkitGetAsEntry: () =>
            directory('/site', [
              [fileEntry('/site/index.html', new File(['x'], 'index.html'))],
              [fileEntry('/site/about.html', new File(['x'], 'about.html'))],
            ]),
        },
      ],
    } as unknown as DataTransfer)

    expect(result.map((file) => webkitRelativePath(file))).toEqual([
      'site/index.html',
      'site/about.html',
    ])
  })

  test('rejects when another entry fails', async () => {
    await expect(
      filesFromDrop({
        files: [],
        items: [
          {
            webkitGetAsEntry: () =>
              fileEntry('/site/index.html', new File(['x'], 'index.html')),
          },
          {
            webkitGetAsEntry: () => failingFileEntry('/site/broken.css'),
          },
        ],
      } as unknown as DataTransfer),
    ).rejects.toThrow()
  })

  test('rejects when a folder child fails', async () => {
    await expect(
      filesFromDrop({
        files: [],
        items: [
          {
            webkitGetAsEntry: () =>
              directory('/site', [
                fileEntry('/site/index.html', new File(['x'], 'index.html')),
                failingFileEntry('/site/broken.css'),
                directory('/site/assets', [
                  fileEntry('/site/assets/app.js', new File(['x'], 'app.js')),
                ]),
              ]),
          },
        ],
      } as unknown as DataTransfer),
    ).rejects.toThrow()
  })

  test('keeps direct files when mixed with entry-backed items', async () => {
    const directFile = new File(['x'], 'notes.md')
    const result = await filesFromDrop({
      files: [],
      items: [
        {
          getAsFile: () => directFile,
          webkitGetAsEntry: () => null,
        },
        {
          getAsFile: () => null,
          webkitGetAsEntry: () =>
            fileEntry('/site/index.html', new File(['x'], 'index.html')),
        },
      ],
    } as unknown as DataTransfer)

    expect(result.map((file) => file.name)).toEqual(['notes.md', 'index.html'])
    expect(result.map((file) => webkitRelativePath(file))).toEqual([
      undefined,
      'site/index.html',
    ])
  })
})

function fileEntry(fullPath: string, file: File) {
  return {
    fullPath,
    isDirectory: false,
    isFile: true,
    file: (resolve: (file: File) => void) => resolve(file),
  }
}

function failingFileEntry(fullPath: string) {
  return {
    fullPath,
    isDirectory: false,
    isFile: true,
    file: (
      _resolve: (file: File) => void,
      reject: (error: DOMException) => void,
    ) => reject(new DOMException('Unreadable file')),
  }
}

function directory(fullPath: string, children: unknown[] | unknown[][]) {
  const batches = Array.isArray(children[0])
    ? (children as unknown[][])
    : [children as unknown[]]
  let readCount = 0
  return {
    fullPath,
    isDirectory: true,
    isFile: false,
    createReader: () => ({
      readEntries: (resolve: (entries: unknown[]) => void) => {
        resolve(batches[readCount] ?? [])
        readCount += 1
      },
    }),
  }
}

function webkitRelativePath(file: File): string | undefined {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath
}
