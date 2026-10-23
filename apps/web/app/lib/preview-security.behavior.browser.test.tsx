import { expect, test } from 'vitest'
import { server } from 'vitest/browser'

test('local preview isolates scripts and accepts only current bounded display observations', async () => {
  expect(await server.commands.previewSecurity()).toBe(true)
}, 60000)
