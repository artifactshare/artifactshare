import { expect, test } from 'vitest'
import { createShareableId } from './shareable-id'

test('shareable IDs use the public ten-character lowercase alphanumeric contract', () => {
  const id = createShareableId()

  expect(id).toHaveLength(10)
  expect(id).toMatch(/^[0-9a-z]+$/)
})
