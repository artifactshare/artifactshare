import '~/app.css'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ProjectPeek, ShareablePeek } from './peek-card'

let root: Root | undefined

afterEach(() => {
  unmount()
  document.documentElement.className = ''
  vi.unstubAllGlobals()
})

function unmount() {
  root?.unmount()
  root = undefined
  document.body.replaceChildren()
}

async function mount(
  kind: 'shareable' | 'project',
  id: string,
  response: unknown,
  options?: { ok?: boolean; locale?: 'ja' | 'en'; disabled?: boolean },
) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: options?.ok ?? true,
      json: async () => response,
    }),
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const Child = kind === 'shareable' ? ShareablePeek : ProjectPeek
  const router = createMemoryRouter(
    [
      {
        id: 'root',
        path: '*',
        loader: () => ({ locale: options?.locale ?? 'en' }),
        element: (
          <Child id={id} disabled={options?.disabled}>
            <button>Open</button>
          </Child>
        ),
      },
    ],
    { initialEntries: ['/test'] },
  )
  root.render(<RouterProvider router={router} />)
  await vi.waitFor(() => expect(host.querySelector('button')).not.toBeNull())
  return host.querySelector('button') as HTMLButtonElement
}

async function focus(trigger: HTMLButtonElement) {
  trigger.focus()
  trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
}

async function hover(trigger: HTMLButtonElement) {
  trigger.dispatchEvent(
    new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }),
  )
}

async function waitForOpenAnimation() {
  await new Promise((resolve) => window.setTimeout(resolve, 150))
}

const shareable = {
  id: 'shareable',
  title: 'This title must appear on one truncated line in the peek'.repeat(4),
  description: null,
  ownerName: 'Owner'.repeat(30),
  ownerId: 'user',
  ownerImage: null,
  viewCount: 12345,
  commentCount: 67890,
  createdAt: '2026-01-01',
  publishedAt: null,
  versionCount: 2,
  containerName: 'Project'.repeat(30),
  containerKind: 'project',
  excerpt: '本文'.repeat(100),
}

const project = {
  id: 'project',
  name: 'Project title must appear on one truncated line'.repeat(4),
  description: 'Description'.repeat(40),
  fileCount: 2,
  participantCount: 1,
  updatedAt: '2026-01-01',
  recentFiles: [
    { id: '1', title: 'A'.repeat(200), kind: 'markdown_page' },
    { id: '2', title: 'B'.repeat(200), kind: 'html_page' },
  ],
}

describe('Peek browser structure', () => {
  test('disabled trigger preserves navigation without requesting peek data', async () => {
    const trigger = await mount('shareable', 'flag-off', shareable, {
      disabled: true,
    })
    await hover(trigger)
    await focus(trigger)
    await new Promise((resolve) => window.setTimeout(resolve, 400))
    expect(fetch).not.toHaveBeenCalled()
    expect(document.querySelector('[data-peek-section]')).toBeNull()
  })

  test('loading, 404, and error stay closed', async () => {
    const pending = new Promise(() => {})
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending))
    const loadingHost = document.createElement('div')
    document.body.appendChild(loadingHost)
    root = createRoot(loadingHost)
    const loadingRouter = createMemoryRouter(
      [
        {
          id: 'root',
          path: '*',
          loader: () => ({ locale: 'en' }),
          element: (
            <ShareablePeek id="loading">
              <button>Loading</button>
            </ShareablePeek>
          ),
        },
      ],
      { initialEntries: ['/loading'] },
    )
    root.render(<RouterProvider router={loadingRouter} />)
    await vi.waitFor(() =>
      expect(loadingHost.querySelector('button')).not.toBeNull(),
    )
    await focus(loadingHost.querySelector('button') as HTMLButtonElement)
    expect(document.querySelector('[data-peek-section]')).toBeNull()

    unmount()
    const missing = await mount('shareable', 'missing', null, { ok: false })
    await focus(missing)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(document.querySelector('[data-peek-section]')).toBeNull()

    unmount()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const errorHost = document.createElement('div')
    document.body.appendChild(errorHost)
    root = createRoot(errorHost)
    const errorRouter = createMemoryRouter(
      [
        {
          id: 'root',
          path: '*',
          loader: () => ({ locale: 'en' }),
          element: (
            <ProjectPeek id="error">
              <button>Error</button>
            </ProjectPeek>
          ),
        },
      ],
      { initialEntries: ['/error'] },
    )
    root.render(<RouterProvider router={errorRouter} />)
    await vi.waitFor(() =>
      expect(errorHost.querySelector('button')).not.toBeNull(),
    )
    await hover(errorHost.querySelector('button') as HTMLButtonElement)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(document.querySelector('[data-peek-section]')).toBeNull()
  })

  test.each([
    ['light', 'ja'],
    ['dark', 'en'],
  ] as const)(
    'focus opens text-first shareable at 320x126 in %s/%s',
    async (theme, locale) => {
      document.documentElement.className = theme
      document.documentElement.lang = locale
      const trigger = await mount(
        'shareable',
        `shareable-${theme}-${locale}`,
        shareable,
        { locale },
      )
      await focus(trigger)
      await new Promise((resolve) => window.setTimeout(resolve, 300))
      expect(
        document.querySelector('[data-peek-section="shareable"]'),
      ).toBeNull()
      await vi.waitFor(() =>
        expect(
          document.querySelector('[data-peek-section="shareable"]'),
        ).not.toBeNull(),
      )
      await waitForOpenAnimation()
      const section = document.querySelector(
        '[data-peek-section="shareable"]',
      ) as HTMLElement
      const card = section.parentElement as HTMLElement
      expect(card.getBoundingClientRect().width).toBe(320)
      expect(card.getBoundingClientRect().height).toBe(126)
      expect(
        [...section.children].map((node) =>
          node.getAttribute('data-peek-part'),
        ),
      ).toEqual(['title', 'body', 'meta'])
      expect(section.querySelector('img')).toBeNull()
      expect(section.textContent).toContain(shareable.title)
      expect(section.querySelector('[data-peek-part="activity"]')).toBeNull()
      const title = section.querySelector(
        '[data-peek-part="title"]',
      ) as HTMLElement
      expect(getComputedStyle(title).whiteSpace).toBe('nowrap')
      expect(title.scrollWidth).toBeGreaterThan(title.clientWidth)
      expect(section.textContent).not.toContain(String(shareable.viewCount))
      expect(section.textContent).not.toContain(String(shareable.commentCount))
    },
  )

  test('pointer hover opens project at 320x206 with stable content order', async () => {
    const trigger = await mount('project', 'project-pointer', project)
    await hover(trigger)
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-peek-section="project"]'),
      ).not.toBeNull(),
    )
    await waitForOpenAnimation()
    const section = document.querySelector(
      '[data-peek-section="project"]',
    ) as HTMLElement
    const card = section.parentElement as HTMLElement
    expect(card.getBoundingClientRect().width).toBe(320)
    expect(card.getBoundingClientRect().height).toBe(206)
    expect(
      [...section.children].map((node) => node.getAttribute('data-peek-part')),
    ).toEqual(['title', 'recent-files', 'description', 'counts'])
    expect(section.textContent).toContain(project.name)
    const title = section.querySelector(
      '[data-peek-part="title"]',
    ) as HTMLElement
    expect(getComputedStyle(title).whiteSpace).toBe('nowrap')
    expect(title.scrollWidth).toBeGreaterThan(title.clientWidth)
  })
})
