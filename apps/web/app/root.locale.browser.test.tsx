import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryRouter,
  Link,
  Outlet,
  RouterProvider,
  useLocation,
  useRouteLoaderData,
} from 'react-router'
import { useEffect } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '~/app.css'
import { shouldRevalidate } from './lib/root-locale'

let root: Root | undefined

function RootHarness() {
  const data = useRouteLoaderData<{ locale: 'en' | 'ja' }>('root')
  const location = useLocation()
  useEffect(() => {
    document.documentElement.lang = data?.locale ?? 'en'
  }, [data?.locale])
  return (
    <div data-pathname={location.pathname}>
      <Outlet />
    </div>
  )
}

function mount() {
  document.body.replaceChildren(document.createElement('div'))
  const router = createMemoryRouter(
    [
      {
        id: 'root',
        path: '/',
        loader: ({ request }) => ({
          locale: new URL(request.url).pathname === '/ja' ? 'ja' : 'en',
        }),
        shouldRevalidate,
        element: <RootHarness />,
        children: [
          {
            index: true,
            element: <main>Share HTML and Markdown made by AI</main>,
          },
          {
            path: 'ja',
            element: (
              <main>
                <p>AIから使う</p>
                <Link to="/">English</Link>
              </main>
            ),
          },
        ],
      },
    ],
    { initialEntries: ['/ja'] },
  )
  root = createRoot(document.body.firstElementChild as HTMLElement)
  root.render(<RouterProvider router={router} />)
}

afterEach(() => {
  root?.unmount()
  root = undefined
})

describe('Japanese home to English home navigation', () => {
  test('applies the Japanese system-font fallback and line-breaking rules', async () => {
    mount()
    await vi.waitFor(() => expect(document.documentElement.lang).toBe('ja'))

    const style = getComputedStyle(document.documentElement)
    expect(style.fontFamily).toContain('Geist Variable')
    expect(style.fontFamily).toContain('Hiragino Sans')
    expect(style.fontFamily).toContain('Noto Sans JP')
    expect(style.fontFamily).toContain('Meiryo')
    expect(style.getPropertyValue('line-break')).toBe('strict')
    expect(style.wordBreak).toBe('auto-phrase')
  })

  test('revalidates the root locale without a document reload', async () => {
    mount()
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('English'),
    )

    const initialDocument = document
    const englishLink = document.querySelector<HTMLAnchorElement>('a[href="/"]')
    expect(englishLink).not.toBeNull()
    englishLink?.click()

    await vi.waitFor(() => {
      expect(document.querySelector('[data-pathname="/"]')).not.toBeNull()
      expect(document.body.textContent).toContain(
        'Share HTML and Markdown made by AI',
      )
    })
    expect(document.documentElement.lang).toBe('en')
    expect(document).toBe(initialDocument)
  })
})
