import { bindI18n } from '~/lib/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { HistoryPanel, HistoryPanelBody, VersionWidget } from './history-panel'
import { hasLocalFiles } from './drag-files'
import { VersionRows } from './version-rows'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'en',
    t: (key: string, vars?: Record<string, string | number>) =>
      ({
        'vw.retentionNoteOther': `Keeping the latest ${vars?.count} versions`,
        'vw.versionHistory': 'History & add new version',
        'vw.versionHistoryReadonly': 'Version history',
        'common.close': 'Close',
        'history.current': 'Current',
        'history.empty': 'No versions yet.',
        'history.viewAll': 'Open history',
        'history.updateShort': 'Update available',
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
        'vw.versionStatusWithUpdate': `Version status: ${vars?.version ?? ''}, new version available`,
      })[key] ?? key,
    tPlural: (_stem: string, count: number) => `${count} new comments`,
  }),
}))

vi.mock('react-router', () => ({
  useRevalidator: () => ({ revalidate: vi.fn() }),
}))

describe('HistoryPanel', () => {
  const createdAt = '2026-05-29T00:00:00.000Z'

  test.each(['panel', 'popover'] as const)(
    '%s rows keep time and size together while truncating long creator names',
    (density) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-29T00:33:00.000Z'))
      try {
        const creator = 'A creator with a very long display name'
        const html = renderToStaticMarkup(
          <VersionRows
            density={density}
            locale="en"
            t={t}
            versions={[
              {
                id: 'v2',
                ordinal: 2,
                createdAt,
                sizeBytes: 420,
                isCurrent: true,
                createdByLabel: creator,
                label: 'A version label that can still wrap',
              },
            ]}
          />,
        )

        expect(html).toContain(
          '<span class="shrink-0 whitespace-nowrap">33 minutes ago</span>',
        )
        expect(html).toContain(
          '<span class="shrink-0 whitespace-nowrap">420 B</span>',
        )
        expect(html).toContain(
          `<span class="min-w-0 truncate">${creator}</span>`,
        )
        expect(html).toContain(
          '<div class="min-w-0 text-sm [overflow-wrap:anywhere]">A version label that can still wrap</div>',
        )
      } finally {
        vi.useRealTimers()
      }
    },
  )

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
            label: '<strong>Restructured</strong>',
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
    expect(html).toContain('&lt;strong&gt;Restructured&lt;/strong&gt;')
    expect(html).not.toContain('<strong>Restructured</strong>')
    expect(html).toContain('[overflow-wrap:anywhere]')
    expect(html.match(/overflow-wrap:anywhere/g)).toHaveLength(1)
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
    expect(html).toContain('Update available')
    expect(html).toContain(
      'aria-label="Version status: v2, new version available"',
    )
  })

  test.each([
    { hidden: false, hasNewerVersion: false, asideHidden: true },
    { hidden: false, hasNewerVersion: true, asideHidden: false },
    { hidden: true, hasNewerVersion: true, asideHidden: true },
  ])('anonymous version landmark visibility: %j', (props) => {
    const html = renderToStaticMarkup(
      <VersionWidget
        versions={[]}
        canViewHistory={false}
        hidden={props.hidden}
        hasNewerVersion={props.hasNewerVersion}
        onOpenHistory={() => {}}
      />,
    )

    expect(html.includes('<aside hidden=""')).toBe(props.asideHidden)
    const [liveRegion, aside] = html.split('<aside')
    expect(liveRegion).toContain('role="status"')
    expect(liveRegion).not.toContain('hidden=')
    if (props.hasNewerVersion) {
      expect(liveRegion).toContain('A new version is available')
      expect(aside).toContain(
        '<span aria-hidden="true">A new version is available</span>',
      )
      expect(aside).toMatch(/<button\b[^>]*>Show latest<\/button>/)
      expect(aside!.match(/<button\b[^>]*>/)?.[0]).not.toContain('aria-hidden')
    } else {
      expect(html).not.toContain('A new version is available')
      expect(aside).not.toContain('<button')
    }
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
          newCommentMessages: [],
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
    'history.updateShort': 'Update available',
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
    'vw.versionStatusWithUpdate': `Version status: ${vars?.version ?? ''}, new version available`,
  })[key] ?? key

test.each([
  { locale: 'en', retainVersions: 1, note: 'Keeping only the latest version' },
  { locale: 'en', retainVersions: 24, note: 'Keeping the latest 24 versions' },
  { locale: 'en', retainVersions: null, note: null },
  { locale: 'ja', retainVersions: 1, note: '最新版だけを残しています' },
  { locale: 'ja', retainVersions: 24, note: '最新24件の版を残しています' },
  { locale: 'ja', retainVersions: null, note: null },
] as const)(
  '$locale history notes configured retention $retainVersions',
  ({ locale, retainVersions, note }) => {
    const html = renderToStaticMarkup(
      <HistoryPanelBody
        retainVersions={retainVersions}
        versions={[]}
        canReplaceFile={false}
        active={false}
        uploading={false}
        inputRef={{ current: null }}
        replaceMode="single"
        setLocalDropActive={() => {}}
        submitFiles={() => {}}
        locale={locale}
        t={bindI18n(locale).t}
      />,
    )
    if (note === null) {
      expect(html).not.toContain('Keeping the latest')
      expect(html).not.toContain('残しています')
    } else {
      expect(html).toContain(`>${note}</p>`)
    }
  },
)

test.each([true, false])(
  'only retention authority exposes the editor, regardless of upload permission: %s',
  (canChangeRetention) => {
    const html = renderToStaticMarkup(
      <HistoryPanelBody
        artifactId="abc123def4"
        canChangeRetention={canChangeRetention}
        retainVersions={2}
        versions={[]}
        canReplaceFile={!canChangeRetention}
        active={false}
        uploading={false}
        inputRef={{ current: null }}
        replaceMode="single"
        setLocalDropActive={() => {}}
        submitFiles={() => {}}
        locale="en"
        t={bindI18n('en').t}
      />,
    )
    expect(html.includes('data-retention-change')).toBe(canChangeRetention)
    if (canChangeRetention) expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('Keeping the latest 2 versions')
  },
)

test.each(['en', 'ja'] as const)(
  '%s scheduled history preserves labels and links without personal attribution',
  (locale) => {
    const html = renderToStaticMarkup(
      <VersionRows
        locale={locale}
        t={bindI18n(locale).t}
        versions={[
          {
            id: 'machine',
            ordinal: 3,
            scheduledUpdate: true,
            label: 'Hourly report',
            createdAt: '2026-06-02T00:00:00.000Z',
            createdByLabel: 'Publisher Author',
            sizeBytes: 10,
            isCurrent: false,
            isDisplayed: true,
          },
          {
            id: 'human',
            createdByLabel: 'Human Author',
            ordinal: 4,
            scheduledUpdate: false,
            createdAt: '2026-06-03T00:00:00.000Z',
            sizeBytes: 10,
            isCurrent: true,
          },
        ]}
      />,
    )
    expect(html).toContain(locale === 'en' ? 'Scheduled update' : '定期更新')
    expect(
      html.split(locale === 'en' ? 'Scheduled update' : '定期更新'),
    ).toHaveLength(2)
    expect(html).toContain('Hourly report')
    expect(html).not.toContain('Publisher Author')
    expect(html).toContain('Human Author')
    expect(html).toContain('?version=machine')
    expect(html).toContain('aria-current="page"')
  },
)

test.each([true, false])(
  'freshness uses the displayed publication independently of history permission (%s)',
  (canViewHistory) => {
    const html = renderToStaticMarkup(
      <VersionWidget
        canViewHistory={canViewHistory}
        displayedPublishedAt="2026-06-02T10:30:00.000Z"
        versions={[]}
        onOpenHistory={() => {}}
      />,
    )
    expect(html).toContain('history.dataUpdated')
    expect(html).toContain('dateTime="2026-06-02T10:30:00.000Z"')
    expect(html).toContain('UTC')
    expect(html).not.toContain('hidden=""')
  },
)

test.each(['en', 'ja'] as const)(
  'managed %s read-only history explains human preservation',
  (locale) => {
    for (const publisherManaged of [false, true]) {
      const html = renderToStaticMarkup(
        <HistoryPanelBody
          retainVersions={2}
          publisherManaged={publisherManaged}
          versions={[]}
          canReplaceFile={false}
          active={false}
          uploading={false}
          inputRef={{ current: null }}
          replaceMode="single"
          setLocalDropActive={() => {}}
          submitFiles={() => {}}
          locale={locale}
          t={bindI18n(locale).t}
        />,
      )
      const protection =
        locale === 'en'
          ? 'All versions people added are kept.'
          : '人が追加した版はすべて残します。'
      expect(html.includes(protection)).toBe(publisherManaged)
      expect(html).toContain(
        locale === 'en'
          ? publisherManaged
            ? 'Keeping the latest 2 scheduled versions.'
            : 'Keeping the latest 2 versions'
          : publisherManaged
            ? '最新2件の定期更新の版'
            : '最新2件の版',
      )
    }
  },
)
