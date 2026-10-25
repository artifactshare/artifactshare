import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { createMemoryRouter, RouterProvider, useLoaderData } from 'react-router'
import { VersionWidget } from './+components/version-widget'
import { HistoryPanelBody } from './+components/history-panel'
import { bindI18n as bindTestI18n } from '~/lib/i18n'
import { RetentionEditor } from './+components/retention-editor'
import ViewerRoute from './+viewer'
import { waitForBrowserLayout } from '~/test/browser-layout'
import '~/app.css'

const state = vi.hoisted(() => ({
  revalidate: vi.fn(),
  locale: 'en' as 'en' | 'ja',
}))
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n(state.locale) }
})
vi.mock('react-router', async (original) => ({
  ...(await original<typeof import('react-router')>()),
  useRevalidator: () => ({ revalidate: state.revalidate }),
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root
let host: HTMLDivElement
let router: ReturnType<typeof createMemoryRouter> | undefined
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  state.locale = 'en'
  state.revalidate.mockReset()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  router?.dispose()
  router = undefined
  host.remove()
  vi.unstubAllGlobals()
  await page.viewport(1280, 800)
})
async function mount(
  retainVersions: number | null = null,
  expand = true,
  publisherManaged = false,
) {
  await act(async () =>
    root.render(
      <HistoryPanelBody
        artifactId="abc123def4"
        canChangeRetention
        retainVersions={retainVersions}
        publisherManaged={publisherManaged}
        versions={[
          {
            id: 'v1',
            ordinal: 1,
            createdAt: '2026-05-29T00:00:00.000Z',
            sizeBytes: 1024,
            isCurrent: true,
          },
        ]}
        canReplaceFile={false}
        active={false}
        uploading={false}
        inputRef={{ current: null }}
        replaceMode="single"
        setLocalDropActive={() => {}}
        submitFiles={() => {}}
        locale={state.locale}
        t={bindTestI18n(state.locale).t}
      />,
    ),
  )
  await waitForBrowserLayout()
  const change = host.querySelector<HTMLButtonElement>(
    '[data-retention-change]',
  )!
  if (expand && change.getAttribute('aria-expanded') === 'false') {
    await page
      .getByRole('button', {
        name: state.locale === 'ja' ? '変更' : 'Change',
        exact: true,
      })
      .click()
  }
}
async function limited(publisherManaged = false) {
  await page
    .getByRole('radio', {
      name: publisherManaged
        ? 'Keep the latest scheduled versions'
        : 'Keep only the latest versions',
    })
    .click()
}
async function submit() {
  await page
    .getByRole('button', { name: 'Save version setting', exact: true })
    .click()
}
function preview(count: number, snapshot = 'snapshot') {
  return Response.json(
    { kind: 'preview', count, proposed: 1, snapshot },
    { status: 409 },
  )
}

test('uses the server count, cancels without another request, and restores keyboard focus', async () => {
  fetchMock.mockResolvedValueOnce(preview(7))
  await mount()
  await limited()
  await submit()
  await vi.waitFor(() =>
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull(),
  )
  expect(document.body.textContent).toContain(
    '7 versions will be removed. This cannot be undone.',
  )
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() =>
    expect(document.querySelector('[role="alertdialog"]')).toBeNull(),
  )
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(
      host.querySelector('[data-retention-save]'),
    ),
  )
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(state.revalidate).not.toHaveBeenCalled()
})

test.each([false, true])(
  'confirmed saves use the exact snapshot, disable duplicate actions and refresh history (managed: %s)',
  async (publisherManaged) => {
    let finish: (value: Response) => void = () => {
      throw new Error('save not started')
    }
    fetchMock.mockResolvedValueOnce(preview(2)).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    state.revalidate.mockImplementation(() => mount(1, true, publisherManaged))
    await mount(null, true, publisherManaged)
    await limited(publisherManaged)
    await submit()
    await vi.waitFor(() =>
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull(),
    )
    const confirmation = document.querySelector('[role="alertdialog"]')!
    expect(confirmation.textContent).toContain(
      publisherManaged
        ? 'Remove older scheduled versions?'
        : 'Remove older versions?',
    )
    expect(confirmation.textContent).toContain(
      publisherManaged
        ? '2 scheduled versions will be removed. All versions people added are kept. This cannot be undone.'
        : '2 versions will be removed. This cannot be undone.',
    )
    await page.getByRole('button', { name: 'Remove versions and save' }).click()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      operation: 'save',
      retain_versions: 1,
      snapshot: 'snapshot',
    })
    expect(
      page
        .getByRole('button', { name: 'Remove versions and save' })
        .element()
        .getAttribute('data-variant'),
    ).toBe('destructive')
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(
      Array.from(dialog.querySelectorAll('button')).every(
        (button) => button.disabled,
      ),
    ).toBe(true)
    expect(document.body.textContent?.match(/Saving…/g)).toHaveLength(1)
    expect(dialog.querySelector('[role="status"]')?.textContent).toBe('Saving…')
    await act(async () => finish(Response.json({ kind: 'saved' })))
    await vi.waitFor(() =>
      expect(document.querySelector('[role="alertdialog"]')).toBeNull(),
    )
    expect(state.revalidate).toHaveBeenCalledTimes(1)
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        host.querySelector('[data-retention-change]'),
      ),
    )
    expect(document.activeElement?.isConnected).toBe(true)
  },
)

test('zero-removal changes save directly, clearing sends null, and failures retain the draft for retry', async () => {
  fetchMock
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(Response.json({ kind: 'saved' }))
  await mount(4)
  await page.getByRole('radio', { name: 'Keep all versions' }).click()
  await submit()
  await vi.waitFor(() =>
    expect(host.textContent).toContain('Could not save. Please try again.'),
  )
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  await submit()
  await vi.waitFor(() => expect(state.revalidate).toHaveBeenCalledTimes(1))
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
    operation: 'save',
    retain_versions: null,
  })
})

test.each(['', '0', '-1', '1.5', '9007199254740992'])(
  'invalid count %s cannot save',
  async (value) => {
    await mount()
    await limited()
    await page
      .getByRole('spinbutton', { name: 'Number of versions to keep' })
      .fill(value)
    await vi.waitFor(() =>
      expect(
        host.querySelector<HTMLButtonElement>('[data-retention-save]')!
          .disabled,
      ).toBe(true),
    )
    expect(host.textContent).toContain('Enter a whole number of at least 1.')
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

test.each([false, true])(
  'stale confirmation displays the fresh count before a second confirmation (managed: %s)',
  async (publisherManaged) => {
    fetchMock
      .mockResolvedValueOnce(preview(2))
      .mockResolvedValueOnce(preview(3, 'fresh'))
    await mount(null, true, publisherManaged)
    await limited(publisherManaged)
    await submit()
    await page.getByRole('button', { name: 'Remove versions and save' }).click()
    await vi.waitFor(() =>
      expect(
        document.querySelector('[role="alertdialog"]')?.textContent,
      ).toContain(
        publisherManaged
          ? '3 scheduled versions will be removed. All versions people added are kept. This cannot be undone.'
          : '3 versions will be removed. This cannot be undone.',
      ),
    )
    expect(state.revalidate).not.toHaveBeenCalled()
    expect(
      document.body.textContent?.match(/The history or setting changed\./g),
    ).toHaveLength(1)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'The history or setting changed.',
    )
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
  },
)

test.each([
  [
    'en',
    'This version was removed by the version retention setting.',
    'Open latest version',
  ],
  ['ja', 'この版は、残す版数の設定により削除されました。', '最新版を開く'],
] as const)(
  'removed page in %s has no sandbox and navigates to latest without obsolete targets',
  async (locale, explanation, latest) => {
    state.locale = locale
    router = createMemoryRouter(
      [
        {
          path: '/a/:id',
          Component: () => (
            <ViewerRoute
              loaderData={{
                kind: 'version-removed',
                user: null,
                latestUrl: '/a/abc123def4',
              }}
            />
          ),
        },
      ],
      { initialEntries: ['/a/abc123def4?version=v1#obsolete'] },
    )
    await act(async () => root.render(<RouterProvider router={router!} />))
    await vi.waitFor(() => expect(host.textContent).toContain(explanation))
    expect(host.querySelector('iframe')).toBeNull()
    const link = page.getByRole('link', { name: latest })
    await link.click()
    await vi.waitFor(() =>
      expect(router!.state.location).toMatchObject({
        pathname: '/a/abc123def4',
        search: '',
        hash: '',
      }),
    )
  },
)

test('edits a valid count and saves zero-removal settings without confirmation', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ kind: 'saved' }))
  await mount(2)
  await page
    .getByRole('spinbutton', { name: 'Number of versions to keep' })
    .fill('5')
  const save = host.querySelector<HTMLButtonElement>('[data-retention-save]')!
  save.focus()
  await userEvent.keyboard('{Enter}')
  await vi.waitFor(() => expect(state.revalidate).toHaveBeenCalledTimes(1))
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
    operation: 'save',
    retain_versions: 5,
  })
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
})

test('revalidation replaces a historical version removed by its owner with the explanation', async () => {
  let removed = false
  function HistoricalVersion() {
    const data = useLoaderData<{ removed: boolean }>()
    return data.removed ? (
      <ViewerRoute
        loaderData={{
          kind: 'version-removed',
          user: null,
          latestUrl: '/a/abc123def4',
        }}
      />
    ) : (
      <RetentionEditor artifactId="abc123def4" retainVersions={null} />
    )
  }
  router = createMemoryRouter(
    [
      {
        id: 'root',
        path: '/a/:id',
        loader: () => ({ removed }),
        Component: HistoricalVersion,
      },
    ],
    { initialEntries: ['/a/abc123def4?version=v1'] },
  )
  state.revalidate.mockImplementation(() => router!.revalidate())
  fetchMock.mockResolvedValueOnce(preview(1)).mockImplementationOnce(() => {
    removed = true
    return Promise.resolve(Response.json({ kind: 'saved' }))
  })
  await act(async () => root.render(<RouterProvider router={router!} />))
  await vi.waitFor(() =>
    expect(host.querySelector('[data-retention-save]')).not.toBeNull(),
  )
  await page.getByRole('button', { name: 'Change', exact: true }).click()
  await limited()
  await submit()
  await vi.waitFor(() =>
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull(),
  )
  await page.getByRole('button', { name: 'Remove versions and save' }).click()
  await vi.waitFor(() =>
    expect(host.textContent).toContain(
      'This version was removed by the version retention setting',
    ),
  )
  expect(host.querySelector('iframe')).toBeNull()
  expect(router.state.location.search).toBe('?version=v1')
})

test.each([1, 2])(
  'Japanese confirmation counts old versions unambiguously for %s',
  async (count) => {
    state.locale = 'ja'
    fetchMock.mockResolvedValueOnce(preview(count))
    await mount(3)
    await page.getByRole('spinbutton', { name: '残す版数' }).fill('1')
    await page
      .getByRole('button', { name: '版数の設定を保存', exact: true })
      .click()
    await vi.waitFor(() =>
      expect(
        document.querySelector('[role="alertdialog"]')?.textContent,
      ).toContain(`古い版を${count}件削除します。この操作は取り消せません。`),
    )
  },
)

test('owner history entry has visible text and a chevron before hover and opens settings by keyboard', async () => {
  const openHistory = vi.fn()
  await act(async () =>
    root.render(
      <VersionWidget
        versions={[]}
        retention={{ limit: null, editable: true }}
        canViewHistory
        onOpenHistory={openHistory}
      />,
    ),
  )
  await page
    .getByRole('button', { name: 'Version status: v-', exact: true })
    .click()
  const entry = page.getByRole('button', {
    name: 'Open history and version settings',
  })
  const button = entry.element() as HTMLButtonElement
  expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
  expect(button.classList.contains('text-foreground')).toBe(true)
  button.focus()
  await userEvent.keyboard('{Enter}')
  expect(openHistory).toHaveBeenCalledOnce()
})

test('untouched settings follow loader changes without replacing focused controls', async () => {
  await mount(2)
  const input = host.querySelector<HTMLInputElement>('input[type="number"]')!
  input.focus()
  await mount(5)
  expect(host.querySelector('input[type="number"]')).toBe(input)
  expect(input.value).toBe('5')
  expect(document.activeElement).toBe(input)
  const save = host.querySelector<HTMLButtonElement>('[data-retention-change]')!
  save.focus()
  await mount(null)
  expect(host.querySelector('input[type="number"]')).toBeNull()
  expect(
    page
      .getByRole('radio', { name: 'Keep all versions' })
      .element()
      .getAttribute('aria-checked'),
  ).toBe('true')
  expect(document.activeElement).toBe(save)
  await mount(3)
  expect(
    host.querySelector<HTMLInputElement>('input[type="number"]')?.value,
  ).toBe('3')
  expect(document.activeElement).toBe(save)
  expect(fetchMock).not.toHaveBeenCalled()
})

test.each(['7', ''])(
  'loader updates preserve an edited draft %j',
  async (value) => {
    await mount(2)
    await page
      .getByRole('spinbutton', { name: 'Number of versions to keep' })
      .fill(value)
    const input = host.querySelector<HTMLInputElement>('input[type="number"]')!
    await mount(null)
    expect(input.value).toBe(value)
    expect(document.activeElement).toBe(input)
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

test('failed submissions retain their edited value through refresh and retry, then follow the loader after success', async () => {
  fetchMock
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(Response.json({ kind: 'saved' }))
  await mount(3)
  await page
    .getByRole('spinbutton', { name: 'Number of versions to keep' })
    .fill('2')
  await submit()
  await vi.waitFor(() =>
    expect(host.textContent).toContain('Could not save. Please try again.'),
  )
  await mount(5)
  expect(
    host.querySelector<HTMLInputElement>('input[type="number"]')?.value,
  ).toBe('2')
  expect(host.textContent).toContain('Could not save. Please try again.')
  state.revalidate.mockImplementation(() => mount(2))
  await submit()
  await vi.waitFor(() => expect(state.revalidate).toHaveBeenCalledOnce())
  await vi.waitFor(() =>
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Saved'),
  )
  expect(
    host.querySelector<HTMLButtonElement>('[data-retention-save]')?.disabled,
  ).toBe(true)
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).retain_versions).toBe(2)
  await mount(6)
  expect(
    host.querySelector<HTMLInputElement>('input[type="number"]')?.value,
  ).toBe('6')
})

test.each([
  ['en', null, 'Keeping all versions', 'Change', 'Saved'],
  ['en', 4, 'Keeping the latest 4 versions', 'Change', 'Saved'],
  ['ja', null, 'すべての版を残しています', '変更', '保存しました'],
  ['ja', 4, '最新4件の版を残しています', '変更', '保存しました'],
] as const)(
  'compact %s summary for %s expands by keyboard and announces a save once',
  async (locale, setting, summary, changeLabel, savedLabel) => {
    state.locale = locale
    await mount(setting, false)
    const change = page.getByRole('button', { name: changeLabel, exact: true })
    expect(host.textContent).toContain(summary)
    expect(change.element().getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('form')!.getBoundingClientRect().height).toBe(0)
    expect(host.querySelector('form')!.hidden).toBe(true)
    const changeButton = change.element() as HTMLButtonElement
    changeButton.focus()
    await userEvent.keyboard('{Enter}')
    expect(changeButton.getAttribute('aria-expanded')).toBe('true')
    expect(changeButton.textContent).toBe(locale === 'en' ? 'Close' : '閉じる')
    await userEvent.keyboard('{Enter}')
    expect(changeButton.getAttribute('aria-expanded')).toBe('false')
    expect(changeButton.textContent).toBe(changeLabel)
    expect(host.querySelector('form')!.hidden).toBe(true)
    await userEvent.keyboard('{Enter}')
    expect(host.querySelector('form')!.hidden).toBe(false)
    const save = host.querySelector<HTMLButtonElement>('[data-retention-save]')!
    expect(save.disabled).toBe(true)
    const radioName =
      locale === 'en' ? 'Keep only the latest versions' : '最新の版だけを残す'
    await page.getByRole('radio', { name: radioName }).click()
    const input = page.getByRole('spinbutton')
    await input.fill('5')
    expect(save.disabled).toBe(false)
    if (setting !== null) {
      await input.fill(String(setting))
      expect(save.disabled).toBe(true)
      await input.fill('5')
    }
    fetchMock.mockResolvedValueOnce(Response.json({ kind: 'saved' }))
    state.revalidate.mockImplementation(() => mount(5))
    save.focus()
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() =>
      expect(host.querySelector('[role="status"]')?.textContent).toBe(
        savedLabel,
      ),
    )
    expect(save.disabled).toBe(true)
    expect(
      Array.from(host.querySelectorAll('[role="status"]')).filter(
        (node) => node.textContent === savedLabel,
      ),
    ).toHaveLength(1)
    await input.fill('6')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('')
    expect(fetchMock).toHaveBeenCalledOnce()
  },
)

test.each([390, 1280])(
  'history is visible before expanding settings at %s pixels',
  async (width) => {
    await page.viewport(width, 600)
    await mount(24, false)
    const change = host.querySelector<HTMLButtonElement>(
      '[data-retention-change]',
    )!
    const row = host.querySelector('li')!
    const summary = change.parentElement!
    expect(summary.getBoundingClientRect().height).toBe(
      change.getBoundingClientRect().height,
    )
    expect(row.getBoundingClientRect().bottom).toBeLessThan(600)
    expect(host.querySelector('form')!.getBoundingClientRect().height).toBe(0)
    await page.getByRole('button', { name: 'Change', exact: true }).click()
    expect(
      host.querySelector('form')!.getBoundingClientRect().height,
    ).toBeGreaterThan(0)
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    expect(host.querySelector('form')!.getBoundingClientRect().height).toBe(0)
    expect(row.getBoundingClientRect().bottom).toBeLessThan(600)
  },
)

test.each(['failed', 'changed'] as const)(
  'editing the count or mode clears the previous %s error',
  async (kind) => {
    const message =
      kind === 'failed'
        ? 'Could not save. Please try again.'
        : 'The history or setting changed.'
    if (kind === 'failed') fetchMock.mockRejectedValue(new Error('offline'))
    else fetchMock.mockImplementation(() => Promise.resolve(preview(0)))
    await mount(4)
    const input = page.getByRole('spinbutton', {
      name: 'Number of versions to keep',
    })
    await input.fill('3')
    await submit()
    await vi.waitFor(() => expect(host.textContent).toContain(message))
    await input.fill('2')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('')
    await submit()
    await vi.waitFor(() => expect(host.textContent).toContain(message))
    await page.getByRole('radio', { name: 'Keep all versions' }).click()
    expect(host.querySelector('[role="status"]')?.textContent).toBe('')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  },
)

test.each([
  ['en', 1],
  ['en', 2],
  ['ja', 1],
  ['ja', 2],
] as const)(
  'managed %s editor wraps protection on mobile and confirms %s scheduled removals',
  async (locale, count) => {
    state.locale = locale
    await page.viewport(390, 844)
    await mount(2, true, true)
    const protection =
      locale === 'en'
        ? 'All versions people added are kept'
        : '人が追加した版はすべて残します'
    expect(host.textContent).toContain(protection)
    const input = page.getByRole('spinbutton')
    await input.fill('1')
    fetchMock.mockResolvedValueOnce(preview(count))
    await page
      .getByRole('button', {
        name: locale === 'en' ? 'Save version setting' : '版数の設定を保存',
        exact: true,
      })
      .click()
    await vi.waitFor(() =>
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull(),
    )
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain(
      locale === 'en'
        ? 'Remove older scheduled versions?'
        : '定期更新の古い版を削除しますか？',
    )
    expect(dialog.textContent).toContain(
      locale === 'en'
        ? `${count} scheduled ${count === 1 ? 'version' : 'versions'} will be removed. All versions people added are kept. This cannot be undone.`
        : `定期更新の古い版を${count}件削除します。人が追加した版はすべて残します。この操作は取り消せません。`,
    )
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      retain_versions: 1,
    })
    expect(host.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    )
  },
)

test.each(['en', 'ja'] as const)(
  'managed %s read-only version menu preserves the protection note',
  async (locale) => {
    state.locale = locale
    for (const publisherManaged of [false, true]) {
      await act(async () =>
        root.render(
          <VersionWidget
            key={String(publisherManaged)}
            versions={[
              {
                id: 'v1',
                ordinal: 1,
                createdAt: '2026-05-29T00:00:00.000Z',
                sizeBytes: 10,
                isCurrent: true,
              },
            ]}
            onOpenHistory={() => {}}
            retention={{ limit: 1, editable: false, publisherManaged }}
          />,
        ),
      )
      await waitForBrowserLayout()
      await page
        .getByRole('button', {
          name: locale === 'en' ? 'Version status: v1' : '版の状態: v1',
          exact: true,
        })
        .click()
      await vi.waitFor(() => expect(host.querySelector('h2')).not.toBeNull())
      expect(
        host.textContent?.includes(
          locale === 'en'
            ? 'All versions people added are kept.'
            : '人が追加した版はすべて残します。',
        ),
      ).toBe(publisherManaged)
    }
  },
)
