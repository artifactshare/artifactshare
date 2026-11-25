// @vitest-environment happy-dom

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'

import { Inline } from './inline'
import { Stack } from './stack'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// The utilities these props emit belong to the visual suite. Here: the
// element rendered, its data-slot, asChild composition, and that each prop
// reaches the markup.
describe('Stack', () => {
  const stack = (props: React.ComponentProps<typeof Stack>) =>
    renderToStaticMarkup(
      <Stack {...props}>
        <span>one</span>
      </Stack>,
    )

  test('renders a slotted container around its children', () => {
    const html = stack({ gap: '3' })
    expect(html.startsWith('<div')).toBe(true)
    expect(html).toContain('data-slot="stack"')
    expect(html).toContain('<span>one</span>')
  })

  test('each layout prop changes what is rendered', () => {
    const plain = stack({ gap: '3' })
    expect(stack({ gap: '4' })).not.toBe(plain)
    expect(stack({ gap: '3', align: 'center' })).not.toBe(plain)
    expect(stack({ gap: '3', justify: 'between' })).not.toBe(plain)
  })

  test('asChild merges layout classes onto the child element', () => {
    const html = renderToStaticMarkup(
      <Stack gap="4" asChild>
        <ul className="max-w-md">
          <li>one</li>
        </ul>
      </Stack>,
    )
    expect(html).toContain('<ul')
    expect(html).toContain('max-w-md')
    expect(html).toContain('<li>one</li>')
    expect(html).not.toContain('<div')
  })
})

describe('Inline', () => {
  test('renders a slotted container around its children', () => {
    const plain = renderToStaticMarkup(
      <Inline gap="2">
        <span>one</span>
      </Inline>,
    )
    expect(plain).toContain('data-slot="inline"')
    expect(plain).toContain('<span>one</span>')
    expect(
      renderToStaticMarkup(
        <Inline gap="2" wrap>
          <span>one</span>
        </Inline>,
      ),
    ).not.toBe(plain)
  })

  test('asChild preserves button semantics', () => {
    const html = renderToStaticMarkup(
      <Inline gap="1" asChild>
        <button type="button" className="rounded-lg border px-2 py-1">
          Action
        </button>
      </Inline>,
    )
    expect(html).toContain('<button')
    expect(html).toContain('type="button"')
    expect(html).toContain('Action')
    expect(html).not.toContain('<div')
  })

  test('asChild merges refs and runs child handlers before wrapper handlers', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const wrapperRef = React.createRef<HTMLButtonElement>()
    const childRef = React.createRef<HTMLButtonElement>()
    const calls: string[] = []
    let wrapperSawPrevented = false

    await React.act(async () => {
      root.render(
        <Inline
          gap="2"
          asChild
          ref={wrapperRef}
          onClick={(event) => {
            calls.push('wrapper')
            wrapperSawPrevented = event.defaultPrevented
          }}
        >
          <button
            ref={childRef}
            type="button"
            onClick={(event) => {
              calls.push('child')
              event.preventDefault()
            }}
          >
            Action
          </button>
        </Inline>,
      )
    })

    const button = container.querySelector('button')
    expect(wrapperRef.current).toBe(button)
    expect(childRef.current).toBe(button)

    await React.act(async () => {
      button!.click()
    })
    expect(calls).toEqual(['child', 'wrapper'])
    expect(wrapperSawPrevented).toBe(true)

    await React.act(async () => root.unmount())
  })
})
