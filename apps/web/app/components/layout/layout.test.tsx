// @vitest-environment happy-dom

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'

import { Inline } from './inline'
import { Stack } from './stack'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('Stack', () => {
  test('renders a vertical flex container with the requested gap', () => {
    const html = renderToStaticMarkup(
      <Stack gap="3">
        <span>one</span>
        <span>two</span>
      </Stack>,
    )
    expect(html).toContain('data-slot="stack"')
    expect(html).toContain('flex flex-col gap-3')
  })

  test('applies alignment and justify props', () => {
    const html = renderToStaticMarkup(
      <Stack gap="2" align="center" justify="between">
        <span>one</span>
      </Stack>,
    )
    expect(html).toContain('items-center')
    expect(html).toContain('justify-between')
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
    expect(html).toContain('flex flex-col gap-4')
    expect(html).toContain('max-w-md')
    expect(html).not.toContain('<div')
  })
})

describe('Inline', () => {
  test('renders a horizontal flex container with wrap enabled', () => {
    const html = renderToStaticMarkup(
      <Inline gap="2" wrap align="center" justify="end">
        <span>one</span>
        <span>two</span>
      </Inline>,
    )
    expect(html).toContain('data-slot="inline"')
    expect(html).toContain('flex flex-row')
    expect(html).toContain('gap-2')
    expect(html).toContain('flex-wrap')
    expect(html).toContain('items-center')
    expect(html).toContain('justify-end')
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
    expect(html).toContain('flex flex-row gap-1')
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
      button?.click()
    })
    expect(calls).toEqual(['child', 'wrapper'])
    expect(wrapperSawPrevented).toBe(true)

    await React.act(async () => root.unmount())
  })
})
