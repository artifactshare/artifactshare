import { bindI18n } from '~/lib/i18n'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import {
  ACCEPTED_FILE_UPLOAD_TYPES,
  ACCEPTED_SITE_UPLOAD_TYPES,
  filterUploadFiles,
  isStaticSiteUpload,
  uploadPathsForFiles,
  validateFiles,
} from '~/lib/upload-artifact-validation'
import {
  createUploadDialogState,
  resolveGrantEmailsForUpload,
  resolveUploadDialogState,
  type UploadDialogState,
  uploadDialogReducer,
} from './upload-artifact-dialog-state'
import { UploadInitialGrants } from './upload-initial-grants'
import {
  UploadArtifactDialog,
  appendSlackNotificationPreference,
  shouldShowSlackNotification,
} from './upload-artifact-dialog'

let copyLocale: 'en' | 'ja' = 'en'
vi.mock('~/hooks/use-t', () => ({
  useT: () => bindI18n(copyLocale),
}))
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => () => {},
  useLocation: () => ({ pathname: '/', search: '' }),
  useRevalidator: () => ({ revalidate: () => {} }),
}))
vi.mock('~/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogContent: ({ children }: { children: ReactNode }) => children,
  DialogHeader: ({ children }: { children: ReactNode }) => children,
  DialogTitle: ({ children }: { children: ReactNode }) =>
    createElement('h2', null, children),
  DialogDescription: ({ children }: { children: ReactNode }) =>
    createElement('p', null, children),
}))

const t = (key: string, vars?: Record<string, string | number>) => {
  if (key === 'visibilityDialog.grants.header.count.private') {
    return `${vars?.count ?? ''} people`
  }
  return key
}

describe('UploadInitialGrants', () => {
  test('does not render the disabled notification email checkbox', () => {
    const html = renderToStaticMarkup(
      createElement(UploadInitialGrants, {
        grantInput: '',
        grantEmails: [],
        uploading: false,
        user: {
          id: 'u1',
          email: 'owner@example.com',
          name: 'Owner',
          image: null,
          initial: 'O',
        },
        t,
        onGrantInputChange: () => {},
        onCommitGrantInput: () => {},
        onRemoveGrantEmail: () => {},
      }),
    )

    expect(html).not.toContain('as-grants-notify')
    expect(html).not.toContain('visibilityDialog.grants.notify.label')
  })
})

describe('UploadArtifactDialog upload validation', () => {
  test.each(['en', 'ja'] as const)(
    'explains viewer methods and upload requirements (%s)',
    (locale) => {
      copyLocale = locale
      const subtitle = renderToStaticMarkup(
        createElement(UploadArtifactDialog, {
          open: true,
          onOpenChange: () => {},
          defaultVisibility: 'private',
          availableVisibilities: ['private'],
          user: {
            id: 'u-owner',
            email: 'owner@example.com',
            name: 'Owner',
            image: null,
            initial: 'O',
          },
        }),
      )
      expect(subtitle).toContain(
        locale === 'en'
          ? 'Viewers can sign in with Google, Microsoft, or an email code.'
          : '閲覧時は Google、Microsoft、メールコードでログインできます。',
      )
      expect(subtitle).toContain(
        locale === 'en'
          ? 'Uploading requires Google or Microsoft.'
          : 'アップロードには Google または Microsoft が必要です。',
      )
    },
  )

  test.each([
    [true, 'workspace', false, true],
    [false, 'workspace', false, false],
    [true, 'private', false, false],
  ])(
    'shows Slack notification choice only for eligible destinations and visibility',
    (hasChannel, visibility, externalPosting, expected) => {
      expect(
        shouldShowSlackNotification(
          hasChannel,
          visibility as never,
          externalPosting,
        ),
      ).toBe(expected)
    },
  )

  test('adds slack_notify=false to FormData when notification is disabled', () => {
    const form = new FormData()
    appendSlackNotificationPreference(form, true)
    expect(form.get('slack_notify')).toBe('false')
  })

  test.each(['wasm', 'WASM', 'parquet', 'PARQUET'])(
    'accepts %s only in folders with an entrypoint',
    (extension) => {
      expect(ACCEPTED_SITE_UPLOAD_TYPES.split(',')).toContain(
        `.${extension.toLowerCase()}`,
      )
      expect(ACCEPTED_FILE_UPLOAD_TYPES.split(',')).not.toContain(
        `.${extension.toLowerCase()}`,
      )
      const asset = new File(
        [new Uint8Array([0, 255])],
        `data/file.${extension}`,
        { type: 'text/html' },
      )
      const index = new File(['<p>Dashboard</p>'], 'index.html')
      expect(validateFiles([index, asset], t)).toBeNull()
      expect(
        validateFiles([new File(['binary'], `file.${extension}`)], t),
      ).toBe('upload.error.unsupported')
      expect(validateFiles([asset], t, { staticSite: true })).toBe(
        'upload.error.missingEntrypoint',
      )
      expect(validateFiles([index, new File(['no'], 'data/file.exe')], t)).toBe(
        'upload.error.unsupportedBundleType',
      )
    },
  )

  test('accepts a single PDF up to the artifact limit but never as a site file', () => {
    expect(ACCEPTED_FILE_UPLOAD_TYPES.split(',')).toContain('.pdf')
    expect(ACCEPTED_SITE_UPLOAD_TYPES.split(',')).not.toContain('.pdf')
    const pdf = (name: string, size: number) =>
      new File([new Uint8Array(size)], name, { type: 'application/pdf' })
    // Larger than the 10 MiB static-site per-file limit, within 25 MiB.
    expect(validateFiles([pdf('report.PDF', 11 * 1024 * 1024)], t)).toBeNull()
    expect(validateFiles([pdf('report.pdf', 25 * 1024 * 1024 + 1)], t)).toBe(
      'upload.error.tooLarge',
    )
    expect(
      validateFiles(
        [new File(['<p>hi</p>'], 'index.html'), pdf('doc.pdf', 1)],
        t,
      ),
    ).toBe('upload.error.unsupportedBundleType')
    expect(validateFiles([pdf('index.pdf', 1)], t, { staticSite: true })).toBe(
      'upload.error.unsupportedBundleType',
    )
  })

  test('accepts a single MP4 up to the artifact limit and keeps site MP4 assets', () => {
    expect(ACCEPTED_FILE_UPLOAD_TYPES.split(',')).toContain('.mp4')
    expect(ACCEPTED_SITE_UPLOAD_TYPES.split(',')).toContain('.mp4')
    const mp4 = (name: string, size: number) =>
      new File([new Uint8Array(size)], name, { type: 'video/mp4' })
    // Larger than the 10 MiB static-site per-file limit, within 25 MiB.
    expect(validateFiles([mp4('Demo.MP4', 11 * 1024 * 1024)], t)).toBeNull()
    expect(validateFiles([mp4('demo.mp4', 25 * 1024 * 1024 + 1)], t)).toBe(
      'upload.error.tooLarge',
    )
    expect(validateFiles([mp4('demo.mov', 1)], t)).toBe(
      'upload.error.unsupported',
    )
    expect(
      validateFiles(
        [new File(['<p>hi</p>'], 'index.html'), mp4('clip.mp4', 1)],
        t,
      ),
    ).toBeNull()
  })

  test('accepts a multi-file static site bundle with an entrypoint', () => {
    expect(
      validateFiles(
        [
          new File(['<p>hi</p>'], 'index.html', { type: 'text/html' }),
          new File(['body{}'], 'style.css', { type: 'text/css' }),
          new File(['{}'], 'data.json', { type: 'application/json' }),
          new File(['{}'], 'blog.data', { type: 'application/json' }),
          new File(['ico'], 'favicon.ico', { type: 'image/x-icon' }),
          new File(['video'], 'demo.mp4', { type: 'video/mp4' }),
          new File(['{}'], 'app.js.map', { type: 'application/json' }),
        ],
        t,
      ),
    ).toBeNull()
  })

  test('accepts Next.js static export sidecar files', () => {
    expect(
      validateFiles(
        [
          new File(['<html></html>'], 'index.html', { type: 'text/html' }),
          new File(['flight'], '__next._tree.txt', { type: 'text/plain' }),
          new File(['flight'], 'about/__next.about.txt', {
            type: 'text/plain',
          }),
          new File(
            ['self.__BUILD_MANIFEST={}'],
            '_next/static/id/_buildManifest.js',
            {
              type: 'text/javascript',
            },
          ),
          new File(['rsc'], 'about.rsc', { type: 'text/x-component' }),
          new File(['meta'], 'about.meta', { type: 'text/plain' }),
        ],
        t,
      ),
    ).toBeNull()
  })

  test('accepts static site files from drag and drop but rejects missing entrypoints', () => {
    expect(
      validateFiles(
        [
          new File(['body{}'], 'style.css', { type: 'text/css' }),
          new File(['console.log(1)'], 'app.js', {
            type: 'text/javascript',
          }),
        ],
        t,
      ),
    ).toBe('upload.error.missingEntrypoint')
  })

  test('maps oversized bundles to the upload size error', () => {
    expect(
      validateFiles(
        [
          new File([new Uint8Array(9 * 1024 * 1024)], 'index.html', {
            type: 'text/html',
          }),
          new File([new Uint8Array(9 * 1024 * 1024)], 'hero.png', {
            type: 'image/png',
          }),
          new File([new Uint8Array(8 * 1024 * 1024)], 'thumb.png', {
            type: 'image/png',
          }),
        ],
        t,
      ),
    ).toBe('upload.error.tooLarge')
  })

  test('rejects static site files over the per-file server limit', () => {
    expect(
      validateFiles(
        [
          new File(['x'], 'index.html', { type: 'text/html' }),
          new File([new Uint8Array(11 * 1024 * 1024)], 'image.png', {
            type: 'image/png',
          }),
        ],
        t,
      ),
    ).toBe('upload.error.fileTooLarge')
  })

  test('matches static site path and count limits before upload', () => {
    expect(
      validateFiles(
        [
          new File(['<p>hi</p>'], 'index.html'),
          ...Array.from(
            { length: 50 },
            (_, i) => new File(['x'], `asset-${i}.txt`),
          ),
        ],
        t,
      ),
    ).toBe('upload.error.tooManyFiles')

    expect(
      validateFiles(
        [
          new File(['<p>hi</p>'], 'index.html'),
          fileWithRelativePath('asset.txt', `site/${'a'.repeat(260)}.txt`),
        ],
        t,
      ),
    ).toBe('upload.error.pathTooLong')

    expect(
      validateFiles(
        [
          fileWithRelativePath('index.html', 'site/index.html'),
          fileWithRelativePath('asset.txt', 'site/a/b/c/d/e/f/g/h/i/j/k/l.txt'),
        ],
        t,
      ),
    ).toBe('upload.error.pathTooDeep')

    expect(
      validateFiles(
        [
          fileWithRelativePath('index.html', 'site/index.html'),
          fileWithRelativePath('logo.txt', 'site/assets/logo.txt'),
          fileWithRelativePath('LOGO.txt', 'site/assets/LOGO.txt'),
        ],
        t,
      ),
    ).toBe('upload.error.duplicatePath')
  })

  test('matches the server entrypoint rules', () => {
    expect(
      validateFiles(
        [
          new File(['<p>hi</p>'], 'index.htm', { type: 'text/html' }),
          new File(['body{}'], 'style.css', { type: 'text/css' }),
        ],
        t,
      ),
    ).toBe('upload.error.missingEntrypoint')
    expect(
      validateFiles(
        [
          new File(['# hi'], 'index.markdown', { type: 'text/markdown' }),
          new File(['body{}'], 'style.css', { type: 'text/css' }),
        ],
        t,
      ),
    ).toBe('upload.error.missingEntrypoint')
  })

  test('preserves nested paths while stripping the selected folder root', () => {
    const files = [
      fileWithRelativePath('index.html', 'site/index.html'),
      fileWithRelativePath('site.css', 'site/assets/site.css'),
      fileWithRelativePath('site.js', 'site/assets/site.js'),
    ]

    expect(uploadPathsForFiles(files)).toEqual([
      'index.html',
      'assets/site.css',
      'assets/site.js',
    ])
    expect(validateFiles(files, t)).toBeNull()
  })

  test('ignores common OS metadata files before validation', () => {
    const files = [
      fileWithRelativePath('index.html', 'site/index.html'),
      fileWithRelativePath('.DS_Store', 'site/.DS_Store'),
      fileWithRelativePath('Thumbs.db', 'site/assets/Thumbs.db'),
      fileWithRelativePath('site.css', 'site/assets/site.css'),
    ]
    const filtered = filterUploadFiles(files)

    expect(uploadPathsForFiles(filtered)).toEqual([
      'index.html',
      'assets/site.css',
    ])
    expect(validateFiles(filtered, t)).toBeNull()
  })

  test('treats a single nested folder file as a static site upload', () => {
    const files = [fileWithRelativePath('page.html', 'site/docs/page.html')]

    expect(uploadPathsForFiles(files)).toEqual(['docs/page.html'])
    expect(isStaticSiteUpload(files)).toBe(true)
    expect(validateFiles(files, t)).toBe('upload.error.missingEntrypoint')
  })
})

describe('UploadArtifactDialog state', () => {
  const user = {
    id: 'u1',
    email: 'owner@example.com',
    name: 'Owner',
    image: null,
    initial: 'O',
  }

  test('collects unique pending grant emails while excluding the owner', () => {
    let state = createUploadDialogState({
      defaultVisibility: 'private',
      open: true,
    })
    state = uploadDialogReducer(state, {
      type: 'grant-input-changed',
      value: 'a@example.com, owner@example.com a@example.com B@example.com',
    })
    state = uploadDialogReducer(state, {
      type: 'grant-input-committed',
      user,
    })

    expect(state.grantInput).toBe('')
    expect(state.grantEmails).toEqual(['a@example.com', 'b@example.com'])
  })

  test('clears pending grants when switching away from private visibility', () => {
    const state = uploadDialogReducer(
      {
        ...createUploadDialogState({
          defaultVisibility: 'private',
          open: true,
        }),
        grantInput: 'a@example.com',
        grantEmails: ['a@example.com'],
      },
      { type: 'visibility-selected', visibility: 'workspace' },
    )

    expect(state.visibility).toBe('workspace')
    expect(state.grantInput).toBe('')
    expect(state.grantEmails).toEqual([])
  })

  test('resets visibility and pending grants when the dialog opens again', () => {
    const state = uploadDialogReducer(
      {
        ...createUploadDialogState({
          defaultVisibility: 'private',
          open: false,
        }),
        visibility: 'workspace',
        grantInput: 'a@example.com',
        grantEmails: ['a@example.com'],
      },
      {
        type: 'props-changed',
        defaultVisibility: 'private',
        open: true,
      },
    )

    expect(state.visibility).toBe('private')
    expect(state.grantInput).toBe('')
    expect(state.grantEmails).toEqual([])
  })

  test('resolves reopened dialog state before reducer storage catches up', () => {
    const staleClosedState: UploadDialogState = {
      ...createUploadDialogState({
        defaultVisibility: 'private',
        open: false,
      }),
      visibility: 'workspace',
      grantInput: 'a@example.com',
      grantEmails: ['a@example.com'],
    }

    const resolved = resolveUploadDialogState(staleClosedState, {
      defaultVisibility: 'private',
      open: true,
    })

    expect(resolved.visibility).toBe('private')
    expect(resolved.grantInput).toBe('')
    expect(resolved.grantEmails).toEqual([])
  })

  test('resolves changed default visibility while keeping pending grants', () => {
    const openState: UploadDialogState = {
      ...createUploadDialogState({
        defaultVisibility: 'private',
        open: true,
      }),
      grantInput: 'a@example.com',
      grantEmails: ['a@example.com'],
    }

    const resolved = resolveUploadDialogState(openState, {
      defaultVisibility: 'workspace',
      open: true,
    })

    expect(resolved.visibility).toBe('workspace')
    expect(resolved.grantInput).toBe('a@example.com')
    expect(resolved.grantEmails).toEqual(['a@example.com'])
  })

  test('includes valid uncommitted grant input for upload', () => {
    expect(
      resolveGrantEmailsForUpload(
        ['a@example.com'],
        'B@example.com owner@example.com invalid',
        user,
      ),
    ).toEqual(['a@example.com', 'b@example.com'])
  })

  test('caps pending grant emails at 50', () => {
    const state = uploadDialogReducer(
      {
        ...createUploadDialogState({
          defaultVisibility: 'private',
          open: true,
        }),
        grantEmails: Array.from(
          { length: 49 },
          (_, index) => `person-${index + 1}@example.com`,
        ),
        grantInput: 'person-50@example.com person-51@example.com',
      },
      {
        type: 'grant-input-committed',
        user,
      },
    )

    expect(state.grantEmails).toHaveLength(50)
    expect(state.grantEmails.at(-1)).toBe('person-50@example.com')
  })
})

function fileWithRelativePath(name: string, webkitRelativePath: string): File {
  const file = new File(['x'], name)
  Object.defineProperty(file, 'webkitRelativePath', {
    value: webkitRelativePath,
  })
  return file
}
