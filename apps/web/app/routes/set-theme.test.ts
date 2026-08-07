import { describe, expect, test } from 'vitest'
import { action } from './set-theme'

describe('/set-theme action', () => {
  test('sets an app theme cookie', async () => {
    const response = await action(actionArgs(requestFor('dark')))

    expect(response.data).toEqual({ theme: 'dark' })
    expect(header(response, 'Set-Cookie')).toContain('__as_theme=dark')
  })

  test('sets system as an app theme cookie', async () => {
    const response = await action(actionArgs(requestFor('system')))

    expect(response.data).toEqual({ theme: 'system' })
    expect(header(response, 'Set-Cookie')).toContain('__as_theme=system')
  })

  test('falls back unsupported themes to system', async () => {
    const response = await action(actionArgs(requestFor('sepia')))

    expect(response.data).toEqual({ theme: 'system' })
    expect(header(response, 'Set-Cookie')).toContain('__as_theme=system')
  })
})

function actionArgs(request: Request) {
  return { request } as never
}

function header(
  response: Awaited<ReturnType<typeof action>>,
  name: string,
): string | null {
  return new Headers(response.init?.headers).get(name)
}

function requestFor(theme: string) {
  const body = new FormData()
  body.set('theme', theme)
  return new Request('https://example.com/set-theme', {
    method: 'POST',
    body,
  })
}
