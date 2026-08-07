import { afterEach, describe, expect, test, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { FileRowMenu } from './+components/file-row-menu'
import '~/app.css'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    t: (key: string) =>
      ({
        'vw.more': 'その他',
        'fileRowMenu.copyUrl': 'リンクをコピー',
        'fileRowMenu.rename': '名前を変更',
        'fileRowMenu.move': '移動',
        'fileRowMenu.visibility': '共有範囲',
        'fileRowMenu.remove': '削除',
      })[key] ?? key,
  }),
}))
let root: Root | undefined

afterEach(() => {
  root?.unmount()
  root = undefined
  document.body.replaceChildren()
})

describe('FileRowMenu browser structure', () => {
  test('opens the owner menu with short ordered labels and no wrapping', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(<FileRowMenu onCopyUrl={() => {}} onAction={() => {}} />)

    const trigger = await vi.waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(
        'button[aria-label="その他"]',
      )
      expect(button).not.toBeNull()
      return button!
    })
    trigger.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerType: 'mouse',
      }),
    )

    const items = await vi.waitFor(() => {
      const found = [
        ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ]
      expect(found).toHaveLength(5)
      return found
    })
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      'リンクをコピー',
      '名前を変更',
      '移動',
      '共有範囲',
      '削除',
    ])
    expect(
      items.every((item) => getComputedStyle(item).whiteSpace === 'nowrap'),
    ).toBe(true)
    expect(items.every((item) => item.scrollWidth <= item.clientWidth)).toBe(
      true,
    )
    const content = document.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-content"]',
    )
    expect(content).not.toBeNull()
    expect(
      parseFloat(getComputedStyle(content!).minWidth),
    ).toBeGreaterThanOrEqual(150)
  })
})
