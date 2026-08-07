import { describe, expect, test, vi } from 'vitest'
import { replaceVersion, type ReplaceVersionInput } from './use-replace-version'

describe('replaceVersion', () => {
  test('sends a single-file replacement to the existing version endpoint', async () => {
    const deps = depsWithResponse(Response.json({ ok: true }))
    const file = new File(['<p>hi</p>'], 'index.html', { type: 'text/html' })

    await replaceVersion({
      shareableId: 'abc123def4',
      input: { kind: 'single', files: [file] },
      toastId: 'toast-1',
      deps,
    })

    expect(deps.fetcher).toHaveBeenCalledWith(
      '/api/shareables/abc123def4/versions',
      expect.objectContaining({ method: 'POST' }),
    )
    const form = formFromFetch(deps.fetcher)
    expect(form.get('file')).toBe(file)
    expect(deps.revalidate).toHaveBeenCalled()
    expect(deps.success).toHaveBeenCalledWith('toast.repaired', {
      id: 'toast-1',
    })
  })

  test('sends static site replacement files with normalized bundle paths', async () => {
    const deps = depsWithResponse(Response.json({ ok: true }))
    const input: ReplaceVersionInput = {
      kind: 'static_site',
      files: [
        fileWithRelativePath('index.html', 'site/index.html'),
        fileWithRelativePath('app.css', 'site/assets/app.css'),
      ],
    }

    await replaceVersion({
      shareableId: 'abc123def4',
      input,
      toastId: 'toast-2',
      deps,
    })

    expect(deps.fetcher).toHaveBeenCalledWith(
      '/api/shareables/abc123def4/versions?artifact_kind=static_site',
      expect.objectContaining({ method: 'POST' }),
    )
    const form = formFromFetch(deps.fetcher)
    const files = form.getAll('file')
    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({ name: 'index.html' })
    expect(files[1]).toMatchObject({ name: 'assets/app.css' })
  })

  test('rejects invalid static site bundles before calling fetch', async () => {
    const deps = depsWithResponse(Response.json({ ok: true }))

    await replaceVersion({
      shareableId: 'abc123def4',
      input: {
        kind: 'static_site',
        files: [new File(['body{}'], 'style.css', { type: 'text/css' })],
      },
      toastId: 'toast-3',
      deps,
    })

    expect(deps.fetcher).not.toHaveBeenCalled()
    expect(deps.loading).not.toHaveBeenCalled()
    expect(deps.error).toHaveBeenCalledWith('upload.error.missingEntrypoint', {
      id: 'toast-3',
    })
  })

  test('rejects unsupported single-file replacements before calling fetch', async () => {
    const deps = depsWithResponse(Response.json({ ok: true }))

    await replaceVersion({
      shareableId: 'abc123def4',
      input: {
        kind: 'single',
        files: [new File(['zip'], 'bundle.zip', { type: 'application/zip' })],
      },
      toastId: 'toast-4',
      deps,
    })

    expect(deps.fetcher).not.toHaveBeenCalled()
    expect(deps.loading).not.toHaveBeenCalled()
    expect(deps.error).toHaveBeenCalledWith('upload.error.phase2', {
      id: 'toast-4',
    })
  })
})

function depsWithResponse(response: Response) {
  return {
    fetcher: vi.fn().mockResolvedValue(response),
    revalidate: vi.fn(),
    t: (key: string) => key,
    loading: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    onSuccess: vi.fn(),
  }
}

function formFromFetch(fetcher: ReturnType<typeof vi.fn>): FormData {
  const init = fetcher.mock.calls[0]?.[1] as RequestInit | undefined
  expect(init?.body).toBeInstanceOf(FormData)
  return init?.body as FormData
}

function fileWithRelativePath(name: string, path: string): File {
  const file = new File(['x'], name)
  Object.defineProperty(file, 'webkitRelativePath', {
    configurable: true,
    value: path,
  })
  return file
}
