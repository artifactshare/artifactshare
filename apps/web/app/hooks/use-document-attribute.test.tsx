// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { useDocumentAttribute } from './use-document-attribute'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement
let root: Root
const html = document.documentElement

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  html.removeAttribute('data-theme')
})

function Theme({ theme }: { theme: string }) {
  useDocumentAttribute('data-theme', theme)
  return null
}

test('the attribute follows the value and the original value comes back on unmount', async () => {
  html.setAttribute('data-theme', 'system')

  await act(async () => root.render(<Theme theme="light" />))
  expect(html.getAttribute('data-theme')).toBe('light')

  await act(async () => root.render(<Theme theme="dark" />))
  expect(html.getAttribute('data-theme')).toBe('dark')

  await act(async () => root.render(<></>))
  expect(html.getAttribute('data-theme')).toBe('system')
})

test('an attribute that was absent is removed on unmount', async () => {
  await act(async () => root.render(<Theme theme="dark" />))
  expect(html.getAttribute('data-theme')).toBe('dark')

  await act(async () => root.render(<></>))
  expect(html.hasAttribute('data-theme')).toBe(false)
})
