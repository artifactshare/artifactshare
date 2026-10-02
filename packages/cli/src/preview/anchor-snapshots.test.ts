import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createPreviewAnchorSnapshots } from './anchor-snapshots.js'
import { createPreviewStore } from './store.js'

const directories: string[] = []
afterEach(() =>
  directories
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
)
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'anchor-snapshots-'))
  directories.push(directory)
  const path = join(directory, 'annotations.json')
  const store = createPreviewStore(path)
  const snapshots = createPreviewAnchorSnapshots(store, false)
  snapshots.reload('v1', '<p>Hello world</p>')
  const annotation = store.createDraft(
    {
      kind: 'text',
      state: 'attached',
      quotedText: 'world',
      prefixText: 'Hello ',
      suffixText: '',
      textStart: 6,
      textEnd: 11,
      cssPath: null,
    },
    'Comment',
  )
  return { store, snapshots, annotation, path }
}

test('adding text above shifts the preview range and persists it', () => {
  const { store, snapshots, path } = fixture()
  snapshots.reload('v2', '<p>Introduction</p><p>Hello world</p>')
  expect(store.all()[0]!.anchor).toMatchObject({
    state: 'attached',
    textStart: 18,
    textEnd: 23,
    currentText: 'world',
  })
  expect(createPreviewStore(path).all()[0]!.anchor).toEqual(
    store.all()[0]!.anchor,
  )
})

test('interior edit verifies current text while preserving the original quote', () => {
  const { store, snapshots } = fixture()
  snapshots.reload('v2', '<p>Hello woNEWrld</p>')
  expect(store.all()[0]!.anchor).toMatchObject({
    state: 'attached',
    textStart: 6,
    textEnd: 14,
    currentText: 'woNEWrld',
    quotedText: 'world',
  })
  snapshots.reload('v1', '<p>Hello world</p>')
  expect(store.all()[0]!.anchor).toMatchObject({
    state: 'attached',
    textStart: 6,
    textEnd: 11,
  })
})

test('deletion stays absent on descendants but undo restores the saved snapshot', () => {
  const { store, snapshots } = fixture()
  snapshots.reload('v2', '<p>XYZ</p>')
  expect(store.all()[0]!.anchor).toMatchObject({
    state: 'orphaned',
    textStart: null,
    textEnd: null,
  })
  snapshots.reload('v3', '<p>XYZ</p><p>Hello world</p>')
  expect(store.all()[0]!.anchor).toMatchObject({
    state: 'orphaned',
    textStart: null,
  })
  snapshots.reload('v1', '<p>Hello world</p>')
  expect(store.all()[0]!.anchor).toMatchObject({
    state: 'attached',
    textStart: 6,
    textEnd: 11,
  })
})
