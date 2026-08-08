import axe from 'axe-core'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { toast } from 'sonner'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { Toaster } from '~/components/ui/sonner'
import '~/app.css'
import {
  headingSnapshotExpression,
  validateHeadingSnapshot,
} from '~/test/scenario-regression-contract'
import DevGallery from './index'

let root: Root | undefined
let consoleError: ReturnType<typeof vi.spyOn> | undefined

async function renderGallery(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  const style = document.createElement('style')
  style.textContent =
    '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'
  document.head.appendChild(style)
  const host = document.createElement('div')
  document.body.replaceChildren(host)
  const router = createMemoryRouter([{ path: '*', element: <DevGallery /> }], {
    initialEntries: [`/dev/gallery?theme=${theme}`],
  })
  root = createRoot(host)
  root.render(
    <>
      <RouterProvider router={router} />
      <Toaster
        position="bottom-center"
        theme={theme}
        expand
        visibleToasts={5}
      />
    </>,
  )
  await vi.waitFor(() =>
    expect(document.querySelector('#gallery-heading')).not.toBeNull(),
  )
  await document.fonts.ready
  await new Promise(requestAnimationFrame)
}

afterEach(() => {
  toast.dismiss()
  root?.unmount()
  root = undefined
  consoleError?.mockRestore()
  consoleError = undefined
  document.head.querySelectorAll('style').forEach((style) => {
    if (style.textContent?.includes('caret-color:transparent')) style.remove()
  })
})

describe('component gallery visual regression', () => {
  test.each(['light', 'dark'] as const)('%s', async (theme) => {
    await page.viewport(1440, 900)
    consoleError = vi.spyOn(console, 'error')
    await renderGallery(theme)
    toast.success('保存しました', { duration: Infinity })
    toast.info('お知らせです', { duration: Infinity })
    toast.warning('確認してください', { duration: Infinity })
    toast.error('保存できませんでした', { duration: Infinity })
    toast.loading('保存しています', { duration: Infinity })
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-sonner-toast]')).toHaveLength(5),
    )
    expect(validateHeadingSnapshot(headingSnapshotExpression()())).toEqual([])
    const axeResult = await axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      },
    })
    expect(axeResult.violations).toEqual([])
    expect(consoleError).not.toHaveBeenCalled()
    await expect(
      page.elementLocator(document.documentElement),
    ).toMatchScreenshot(`gallery-${theme}.png`)
  })
})
