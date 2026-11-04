import { expect, test } from 'vitest'
import { server } from 'vitest/browser'

test('authenticated launcher isolates documents, reconnects SSE and binds sharing to the current popup', async () => {
  expect(await server.commands.previewSecurity()).toBe(true)
}, 60000)
