import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { HistoryPanel, HistoryPanelBody, VersionWidget } from './history-panel'
import { hasLocalFiles } from './drag-files'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'en',
    t: (key: string, vars?: Record<string, string | number>) =>
      ({
        'vw.versionHistory': 'History & add new version',
        'vw.versionHistoryReadonly': 'Version history',
        'common.close': 'Close',
        'history.current': 'Current',
        'history.empty': 'No versions yet.',
        'history.viewAll': 'Open history',
        'history.updateShort': 'Update',
        'history.updateAvailable': 'A new version is available',
        'history.showLatest': 'Show latest',
        'history.dropTitle': 'Add new version',
        'history.dropCaption': 'Drop here, or use the button below',
        'history.pickFile': 'Choose file...',
        'history.uploadingTitle': 'Uploading',
        'history.uploadingCaption': 'Registering a new version...',
        'upload.pick.folder': 'Upload site folder',
        'upload.error.missingFile': 'Choose a file to upload.',
        'vw.versionStatus': 'Version status',
        'vw.activityStatus': 'Activity and version status',
        'vw.versionStatusWithVersion': `Version status: ${vars?.version ?? ''}`,
      })[key] ?? key,
    tPlural: (_stem: string, count: number) => `${count} new comments`,
  }),
}))

vi.mock('react-router', () => ({
  useRevalidator: () => ({ revalidate: vi.fn() }),
}))

describe('HistoryPanel', () => {
  const createdAt = '2026-05-29T00:00:00.000Z'

  test('body renders version list, current badge, size, and dropzone when writable', () => {
    const html = renderToStaticMarkup(
      <HistoryPanelBody
        canReplaceFile={true}
        active={false}
        uploading={false}
        inputRef={{ current: null }}
        setLocalDropActive={() => {}}
        replaceMode="single"
        submitFiles={() => {}}
        locale="en"
        t={t}
        versions={[
          {
            id: 'v2',
            ordinal: 2,
            createdAt,
            sizeBytes: 2 * 1024 * 1024,
            isCurrent: true,
          },
          {
            id: 'v1',
            ordinal: 1,
            createdAt,
            sizeBytes: 1024,
            isCurrent: false,
          },
        ]}
      />,
    )

    expect(html).toContain('v2')
    expect(html).toContain('Current')
    expect(html).toContain('2.0 MB')
    expect(html).toContain('Add new version')
    expect(html).toContain('Choose file...')
  })

  test('uploading=true swaps dropzone to a non-interactive uploading state', () => {
    const html = renderToStaticMarkup(
      <HistoryPanelBody
        canReplaceFile={true}
        active={false}
        uploading={true}
        inputRef={{ current: null }}
        setLocalDropActive={() => {}}
        replaceMode="single"
        submitFiles={() => {}}
        locale="en"
        t={t}
        versions={[]}
      />,
    )

    expect(html).toContain('Uploading')
    expect(html).toContain('Registering a new version')
    expect(html).not.toContain('Add new version')
    expect(html).toContain('disabled=""')
  })

  test('readonly body omits dropzone block entirely', () => {
    const html = renderToStaticMarkup(
      <HistoryPanelBody
        canReplaceFile={false}
        active={false}
        uploading={false}
        inputRef={{ current: null }}
        setLocalDropActive={() => {}}
        replaceMode="single"
        submitFiles={() => {}}
        locale="en"
        t={t}
        versions={[
          {
            id: 'v1',
            ordinal: 1,
            createdAt,
            sizeBytes: 1024,
            isCurrent: true,
          },
        ]}
      />,
    )

    expect(html).toContain('v1')
    expect(html).toContain('Current')
    expect(html).not.toContain('Add new version')
    expect(html).not.toContain('Choose file...')
    expect(html).not.toContain('data-panel-dropzone')
  })

  test('closed panel omits sheet content', () => {
    const html = renderToStaticMarkup(
      <HistoryPanel
        open={false}
        onOpenChange={() => {}}
        onSubmit={() => {}}
        versions={[]}
      />,
    )

    expect(html).not.toContain('Version history')
  })

  test('version widget renders current version and update state', () => {
    const html = renderToStaticMarkup(
      <VersionWidget
        versions={[
          {
            id: 'v2',
            ordinal: 2,
            createdAt,
            sizeBytes: 2048,
            isCurrent: true,
            createdByLabel: 'coji',
          },
        ]}
        hasNewerVersion={true}
        onOpenHistory={() => {}}
      />,
    )

    expect(html).toContain('v2')
    expect(html).toContain('Update')
    expect(html).toContain('aria-label="Version status: v2"')
  })

  test('version widget labels the displayed historical version', () => {
    const html = renderToStaticMarkup(
      <VersionWidget
        versions={[
          {
            id: 'v2',
            ordinal: 2,
            createdAt,
            sizeBytes: 2048,
            isCurrent: true,
          },
          {
            id: 'v1',
            ordinal: 1,
            createdAt,
            sizeBytes: 1024,
            isCurrent: false,
            isDisplayed: true,
          },
        ]}
        onOpenHistory={() => {}}
      />,
    )

    expect(html).toContain('aria-label="Version status: v1"')
  })

  test('version widget renders the combined revisit clues', () => {
    const html = renderToStaticMarkup(
      <VersionWidget
        versions={[
          {
            id: 'version-2',
            ordinal: 2,
            createdAt,
            sizeBytes: 2048,
            isCurrent: true,
            createdByLabel: 'Mina',
          },
        ]}
        revisitContext={{
          entryCurrentVersionId: 'version-2',
          version: { kind: 'ordinal', from: 1, to: 2 },
          commentCount: 2,
        }}
        onCommentsOpen={() => {}}
        onOpenHistory={() => {}}
      />,
    )

    expect(html).toContain('Updated v1')
    expect(html).toContain('2 new comments')
    expect(html).toContain('Activity and version status')
  })

  test('static site replacement mode accepts multiple bundle files', () => {
    const html = renderToStaticMarkup(
      <HistoryPanelBody
        canReplaceFile={true}
        active={false}
        uploading={false}
        inputRef={{ current: null }}
        setLocalDropActive={() => {}}
        replaceMode="static_site"
        submitFiles={() => {}}
        locale="en"
        t={t}
        versions={[]}
      />,
    )

    expect(html).toContain('multiple=""')
    expect(html).toContain('.css')
    expect(html).toContain('.woff2')
    expect(html).toContain('Upload site folder')
  })

  test('hasLocalFiles distinguishes OS file drag from text drag', () => {
    const transfer = { types: ['Files'] } as unknown as DataTransfer

    expect(hasLocalFiles(transfer)).toBe(true)
    expect(
      hasLocalFiles({ types: ['text/plain'] } as unknown as DataTransfer),
    ).toBe(false)
  })
})

const t = (key: string, vars?: Record<string, string | number>) =>
  ({
    'vw.versionHistory': 'Version history',
    'common.close': 'Close',
    'history.current': 'Current',
    'history.empty': 'No versions yet.',
    'history.viewAll': 'Open history',
    'history.updateShort': 'Update',
    'history.updateAvailable': 'A new version is available',
    'history.showLatest': 'Show latest',
    'history.dropTitle': 'Add new version',
    'history.dropCaption': 'Drop here, or use the button below',
    'history.pickFile': 'Choose file...',
    'history.uploadingTitle': 'Uploading',
    'history.uploadingCaption': 'Registering a new version...',
    'upload.pick.folder': 'Upload site folder',
    'upload.error.missingFile': 'Choose a file to upload.',
    'vw.versionStatus': 'Version status',
    'vw.versionStatusWithVersion': `Version status: ${vars?.version ?? ''}`,
  })[key] ?? key
