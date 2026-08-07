import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router'

import { Button } from '~/components/ui/button'
import { Inline } from '~/components/layout/inline'
import { Stack } from '~/components/layout/stack'
import { isViteDev } from '~/lib/is-vite-dev'
import { gallerySections } from './+components/registry'

const THEMES = ['light', 'dark', 'system'] as const
type GalleryTheme = (typeof THEMES)[number]

function parseTheme(value: string | null): GalleryTheme {
  return (THEMES as readonly string[]).includes(value ?? '')
    ? (value as GalleryTheme)
    : 'light'
}

export function loader() {
  if (!isViteDev()) throw new Response(null, { status: 404 })
  return null
}

export function meta() {
  return [{ title: 'Component gallery' }]
}

export default function DevGallery() {
  const [searchParams, setSearchParams] = useSearchParams()
  const theme = parseTheme(searchParams.get('theme'))
  const originalTheme = useRef<string | undefined>(undefined)

  useEffect(() => {
    originalTheme.current = document.documentElement.dataset.theme
    return () => {
      const html = document.documentElement
      if (originalTheme.current === undefined) delete html.dataset.theme
      else html.dataset.theme = originalTheme.current
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return (
    <div id="gallery-top" className="bg-background text-foreground min-h-dvh">
      <div className="mx-auto max-w-5xl p-6">
        <Stack gap="8">
          <Stack gap="3" asChild>
            <header>
              <h1 id="gallery-heading" className="text-2xl font-semibold">
                Component gallery
              </h1>
              <p className="text-muted-foreground text-sm">
                components/ui・form・layout と主要な app 固有部品の状態。dev
                専用 (Vite dev 以外は 404)。
              </p>
              <Inline gap="2" align="center">
                <span className="text-muted-foreground text-sm">Theme</span>
                {THEMES.map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={option === theme ? 'default' : 'outline'}
                    aria-pressed={option === theme}
                    onClick={() =>
                      setSearchParams(
                        (prev) => {
                          prev.set('theme', option)
                          return prev
                        },
                        { replace: true },
                      )
                    }
                  >
                    {option}
                  </Button>
                ))}
              </Inline>
              <nav className="flex flex-wrap gap-x-3 gap-y-1">
                {gallerySections.map((section) => (
                  <a
                    key={section.id}
                    href={`#${section.id}`}
                    className="text-muted-foreground hover:text-foreground text-xs"
                  >
                    {section.title}
                  </a>
                ))}
              </nav>
            </header>
          </Stack>
          <Stack gap="10" asChild>
            <main>
              {gallerySections.map((section) => (
                <Stack key={section.id} gap="4" asChild>
                  <section
                    id={section.id}
                    aria-labelledby={`${section.id}-heading`}
                    className="scroll-mt-6"
                  >
                    <div className="border-b pb-2">
                      <Inline gap="3" align="baseline" justify="between">
                        <h2
                          id={`${section.id}-heading`}
                          className="text-base font-semibold"
                        >
                          {section.title}
                        </h2>
                        <code className="text-muted-foreground text-xs">
                          {section.file}
                        </code>
                      </Inline>
                    </div>
                    {section.element}
                  </section>
                </Stack>
              ))}
            </main>
          </Stack>
        </Stack>
      </div>
    </div>
  )
}
