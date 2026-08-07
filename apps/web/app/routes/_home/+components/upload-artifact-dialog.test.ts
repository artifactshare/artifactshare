import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import {
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
  appendSlackNotificationPreference,
  shouldShowSlackNotification,
} from './upload-artifact-dialog'

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

  test('accepts a multi-file static site bundle with an entrypoint', () => {
    expect(
      validateFiles(
        [
          new File(['<p>hi</p>'], 'index.html', { type: 'text/html' }),
          new File(['body{}'], 'style.css', { type: 'text/css' }),
          new File(['{}'], 'data.json', { type: 'application/json' }),
          new File(['{}'], 'blog.data', { type: 'application/json' }),
          new File(['ico'], 'favicon.ico', { type: 'image/x-icon' }),
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
