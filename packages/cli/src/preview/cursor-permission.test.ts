import assert from 'node:assert/strict'
import { test } from 'vitest'
import { formatCursorPermissionRequest } from './cursor-permission.js'

test('Cursor permission display includes the full request without terminal controls', () => {
  const display = formatCursorPermissionRequest({
    title: 'Edit report\u001b[2J\u009b2J\u202ereversed',
    kind: 'edit',
    content: [
      {
        type: 'diff',
        path: '/tmp/report.md',
        oldText: 'before',
        newText: 'after',
      },
    ],
  })

  assert.match(display, /Edit report/)
  assert.match(display, /\/tmp\/report\.md/)
  assert.match(display, /before/)
  assert.match(display, /after/)
  assert.equal(display.includes('\u001b'), false)
  assert.equal(display.includes('\u009b'), false)
  assert.equal(display.includes('\u202e'), false)
})

test('Cursor permission display caps unexpectedly large requests', () => {
  const display = formatCursorPermissionRequest({ content: 'x'.repeat(20_000) })
  assert.match(display, /truncated/)
  assert.ok(display.length < 13_000)
})
