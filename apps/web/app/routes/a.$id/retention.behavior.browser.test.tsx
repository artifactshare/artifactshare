import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { createMemoryRouter, RouterProvider, useLoaderData } from 'react-router'
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
})
async function mount(retainVersions: number | null = null) {
  await act(async () =>
    root.render(
      <RetentionEditor
        artifactId="abc123def4"
        retainVersions={retainVersions}
      />,
    ),
  )
  await waitForBrowserLayout()
}
async function limited() {
  await page
    .getByRole('radio', { name: 'Keep only the latest versions' })
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

test('confirmed saves use the exact snapshot, disable duplicate actions and refresh history', async () => {
  let finish: (value: Response) => void = () => {
    throw new Error('save not started')
  }
  fetchMock.mockResolvedValueOnce(preview(2)).mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
  )
  await mount()
  await limited()
  await submit()
  await vi.waitFor(() =>
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull(),
  )
  await page.getByRole('button', { name: 'Remove versions and save' }).click()
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
    operation: 'save',
    retain_versions: 1,
    snapshot: 'snapshot',
  })
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(
    Array.from(dialog.querySelectorAll('button')).every(
      (button) => button.disabled,
    ),
  ).toBe(true)
  await act(async () => finish(Response.json({ kind: 'saved' })))
  await vi.waitFor(() =>
    expect(document.querySelector('[role="alertdialog"]')).toBeNull(),
  )
  expect(state.revalidate).toHaveBeenCalledTimes(1)
})

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

test.each(['', '0', '-1', '1.5'])(
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

test('stale confirmation displays the fresh count before a second confirmation', async () => {
  fetchMock
    .mockResolvedValueOnce(preview(2))
    .mockResolvedValueOnce(preview(3, 'fresh'))
  await mount()
  await limited()
  await submit()
  await page.getByRole('button', { name: 'Remove versions and save' }).click()
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain('3 versions will be removed.'),
  )
  expect(state.revalidate).not.toHaveBeenCalled()
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
})

test.each([
  [
    'en',
    'This version was removed by the version retention setting',
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
