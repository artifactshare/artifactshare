import { afterEach, describe, expect, test, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { page } from 'vitest/browser'
import { FileRow } from './+components/file-row'
import type { FileRowData } from './+components/file-data'
import { fileDateHeadingClassName } from './+components/file-list-styles'
import '~/app.css'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    t: (key: string) =>
      ({
        'vw.more': 'More actions',
        'fileRowMenu.copyUrl': 'Copy link',
        'fileRowMenu.rename': 'Rename',
        'fileRowMenu.move': 'Move',
        'fileRowMenu.visibility': 'Visibility',
        'fileRowMenu.remove': 'Remove',
        'author.external': 'External',
      })[key] ?? key,
    tPlural: (key: string, count: number) => `${key}:${count}`,
  }),
}))

vi.mock('./+hooks/use-file-labels', () => ({
  useFileLabels: () => ({
    owner: 'A deliberately long owner name for compact layout',
    modified: '2026-07-31',
    activity: 'Viewed',
    visibility: 'Workspace',
  }),
}))

const file: FileRowData = {
  id: 'home-compact-file',
  fileName: 'home-compact-file.html',
  derivedTitle:
    'A deliberately long home title that must wrap only twice in a compact row',
  titleOverride: null,
  renderType: 'html',
  ownerEmail: 'owner@example.com',
  ownerId: 'owner',
  ownerName: 'A deliberately long owner name for compact layout',
  ownerImage: null,
  ownerInitial: 'O',
  ownerIsExternal: false,
  registeredByMe: true,
  visibility: 'workspace',
  viewCount: 42,
  commentCount: 7,
  modifiedTime: '2026-07-31T11:00:00.000Z',
  projectName: 'Content-rich project',
}

let root: Root | undefined
afterEach(() => {
  root?.unmount()
  root = undefined
  document.body.replaceChildren()
})

async function mount(homeCompact: boolean, data: FileRowData = file) {
  const host = document.createElement('div')
  host.style.width = '760px'
  host.style.containerType = 'inline-size'
  document.body.appendChild(host)
  root = createRoot(host)
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <FileRow
            data={data}
            homeCompact={homeCompact}
            inlineOwner={homeCompact}
            menuEnabled
            richStats
            hideMobileVisibility
            recencyPresentation="grouped-with-preview"
          />
        ),
      },
    ],
    { initialEntries: ['/'] },
  )
  root.render(<RouterProvider router={router} />)
  await vi.waitFor(() =>
    expect(host.querySelector('a[aria-label]')).not.toBeNull(),
  )
  return { host, row: host.firstElementChild as HTMLElement }
}

function mountDateHeading(homeCompact: boolean) {
  const heading = document.createElement('div')
  heading.className = `${fileDateHeadingClassName}${homeCompact ? ' max-stack:px-0' : ''}`
  document.body.appendChild(heading)
  return heading
}

function visible(node: HTMLElement) {
  return getComputedStyle(node).display !== 'none'
}

describe('home compact FileRow container behavior', () => {
  test.each([
    { viewport: 779, expectedPadding: '0px', expectedLinkReserve: 40 },
    { viewport: 780, expectedPadding: '12px', expectedLinkReserve: 52 },
    { viewport: 1024, expectedPadding: '12px', expectedLinkReserve: 52 },
  ])(
    'uses viewport width $viewport for Home compact row and date heading padding',
    async ({ viewport, expectedPadding, expectedLinkReserve }) => {
      await page.viewport(viewport, 900)
      const { host, row } = await mount(true)
      const heading = mountDateHeading(true)

      expect(host.getBoundingClientRect().width).toBe(760)
      expect(getComputedStyle(heading).paddingInline).toBe(expectedPadding)
      expect(getComputedStyle(row).paddingInline).toBe(expectedPadding)

      const link = row.querySelector<HTMLElement>('a[aria-label]')!
      const actions = row.lastElementChild as HTMLElement
      const rowRect = row.getBoundingClientRect()
      const linkRect = link.getBoundingClientRect()
      const actionsRect = actions.getBoundingClientRect()
      expect(linkRect.left).toBeGreaterThanOrEqual(rowRect.left)
      expect(rowRect.right - linkRect.right).toBe(expectedLinkReserve)
      expect(linkRect.right).toBeLessThanOrEqual(actionsRect.left)
      expect(actionsRect.right).toBeLessThanOrEqual(rowRect.right)
    },
  )

  test('keeps the existing 12px padding for non-compact recent rows at a narrow viewport', async () => {
    await page.viewport(390, 844)
    const { row } = await mount(false)
    const heading = mountDateHeading(false)

    expect(getComputedStyle(heading).paddingInline).toBe('12px')
    expect(getComputedStyle(row).paddingInline).toBe('12px')
  })

  test('switches only at the owner container boundary and stays inside it', async () => {
    await page.viewport(1440, 900)
    const { host, row } = await mount(true)
    const title = row.querySelector<HTMLElement>('.font-medium')!
    const mobileMeta = row.querySelector<HTMLElement>(
      '[data-regression-responsive="mobile-only"]',
    )!
    const actions = row.lastElementChild as HTMLElement
    const ownerText = 'A deliberately long owner name for compact layout'

    host.style.width = '900px'
    await vi.waitFor(() => expect(visible(mobileMeta)).toBe(false))
    expect(host.textContent?.match(new RegExp(ownerText, 'g'))).toHaveLength(1)
    expect(getComputedStyle(title).webkitLineClamp).toBe('2')
    expect(getComputedStyle(title).whiteSpace).toBe('normal')
    const wideColumns = getComputedStyle(row).gridTemplateColumns.split(' ')
    expect(wideColumns).toHaveLength(4)
    const link = row.querySelector<HTMLElement>('a[aria-label]')!
    const visibleActions = [
      ...actions.querySelectorAll<HTMLElement>('button'),
    ].filter(visible)
    expect(link.getBoundingClientRect().right).toBeLessThanOrEqual(
      Math.min(
        ...visibleActions.map((action) => action.getBoundingClientRect().left),
      ),
    )

    host.style.width = '779px'
    await vi.waitFor(() => expect(visible(mobileMeta)).toBe(true))
    expect(host.textContent?.match(new RegExp(ownerText, 'g'))).toHaveLength(1)
    expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(
      host.getBoundingClientRect().right,
    )
    expect(title.getBoundingClientRect().right).toBeLessThanOrEqual(
      host.getBoundingClientRect().right,
    )
    expect(mobileMeta.getBoundingClientRect().right).toBeLessThanOrEqual(
      host.getBoundingClientRect().right,
    )
    expect(actions.getBoundingClientRect().right).toBeLessThanOrEqual(
      host.getBoundingClientRect().right,
    )
    expect(
      [...actions.querySelectorAll<HTMLElement>('button')].filter(visible),
    ).toHaveLength(1)
    expect(
      actions.querySelector('button[aria-label="More actions"]'),
    ).not.toBeNull()
    expect(getComputedStyle(row).gridTemplateColumns.split(' ')[1]).toBe('40px')
  })

  test('recent/files rows retain their existing structure at the same widths', async () => {
    await page.viewport(390, 844)
    const { host, row } = await mount(false)
    const mobileMeta = row.querySelector<HTMLElement>(
      '[data-regression-responsive="mobile-only"]',
    )!
    expect(visible(mobileMeta)).toBe(true)
    expect(row.className).toContain('max-wide:grid-cols-[minmax(0,1fr)_76px]')
    expect(row.className).not.toContain('grid-cols-[minmax(0,1fr)_76px] @min-')
    const title = row.querySelector<HTMLElement>('.font-medium')!
    expect(getComputedStyle(title).textOverflow).toBe('ellipsis')
  })

  test('lost-access rows reserve no dead action area at either container width', async () => {
    await page.viewport(1440, 900)
    const { host, row } = await mount(true, { ...file, lostAccess: true })
    const link = row.querySelector<HTMLElement>('a[aria-label]')!

    for (const width of ['900px', '779px']) {
      host.style.width = width
      await vi.waitFor(() =>
        expect(
          getComputedStyle(row).gridTemplateColumns.split(' '),
        ).toHaveLength(1),
      )
      expect(row.querySelectorAll('button')).toHaveLength(0)
      expect(link.getBoundingClientRect().right).toBe(
        row.getBoundingClientRect().right,
      )
      expect(
        [...row.children].filter(
          (child) =>
            child instanceof HTMLElement &&
            getComputedStyle(child).display !== 'none',
        ),
      ).toHaveLength(2)
    }
  })
})
