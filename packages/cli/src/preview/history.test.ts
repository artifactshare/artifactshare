import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  PREVIEW_MUTATION_HEADER,
  PREVIEW_MUTATION_HEADER_VALUE,
} from './contract.js'
import {
  createPreviewHistory,
  PREVIEW_HISTORY_MAX_SNAPSHOT_BYTES,
} from './history.js'
import { type PreviewServer, startPreviewServer } from './server.js'
import { createPreviewStore } from './store.js'

const headers = {
  'content-type': 'application/json',
  [PREVIEW_MUTATION_HEADER]: PREVIEW_MUTATION_HEADER_VALUE,
}
let running: PreviewServer | null = null

afterEach(async () => {
  running?.close()
  await running?.closed
  running = null
})

async function start(historyDir: string, content = '<h1>Before</h1>') {
  const dir = mkdtempSync(join(tmpdir(), 'as-preview-history-'))
  const filePath = join(dir, 'doc.html')
  writeFileSync(filePath, content)
  const store = createPreviewStore(join(dir, 'annotations.json'))
  running = await startPreviewServer({
    filePath,
    store,
    sessionId: 'history-test',
    historyDir: historyDir === '' ? join(dir, 'history') : historyDir,
  })
  const port = running.port
  const post = async (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  return { dir, filePath, store, post }
}

async function submitTwo(
  post: (path: string, body: unknown) => Promise<Response>,
) {
  for (const comment of ['First note', 'Second note'])
    await post('/api/annotations', { anchor: { kind: 'artifact' }, comment })
  expect((await post('/api/annotations/submit', {})).status).toBe(200)
  const next = await post('/api/agent/next', { wait: 0 })
  return (
    (await next.json()) as { items: { thread: string; generation: number }[] }
  ).items
}

test('partial reports keep before, each report revision and the final after', async () => {
  const { dir, filePath, post } = await start('')
  const items = await submitTwo(post)
  const history = createPreviewHistory(join(dir, 'history'), '')
  const [summary] = history.list()
  expect(summary).toMatchObject({
    items: 2,
    fixed: 0,
    skipped: 0,
    completed_at: null,
  })

  writeFileSync(filePath, '<h1>Middle</h1>')
  await post('/api/agent/done', {
    items: [{ ...items[0], outcome: 'fixed', note: 'Rewrote it' }],
  })
  let record = history.read(summary!.batch_id)!
  expect(record.completed_at).toBeNull()
  expect(record.snapshots[record.after_revision!]).toMatchObject({
    content: '<h1>Middle</h1>',
  })

  writeFileSync(filePath, '<h1>After</h1>')
  await post('/api/agent/done', {
    items: [{ ...items[1], outcome: 'skipped' }],
  })
  record = history.read(summary!.batch_id)!
  expect(typeof record.completed_at).toBe('string')
  expect(record.snapshots[record.before_revision]).toMatchObject({
    encoding: 'utf8',
    content: '<h1>Before</h1>',
  })
  expect(record.snapshots[record.after_revision!]).toMatchObject({
    content: '<h1>After</h1>',
  })
  expect(record.reports.map((report) => report.items[0]!.outcome)).toEqual([
    'fixed',
    'skipped',
  ])
  // Skipped stays distinct from fixed; neither is a person's approval.
  expect(record.reports[1]!.items[0]).toMatchObject({
    note: null,
    reported_by: 'agent',
  })
  expect(history.list()[0]).toMatchObject({ fixed: 1, skipped: 1 })

  // A repeated report changes nothing and adds no history entry.
  await post('/api/agent/done', { items: [{ ...items[1], outcome: 'fixed' }] })
  expect(history.read(summary!.batch_id)!.reports).toHaveLength(2)
  const file = join(dir, 'history', `${summary!.batch_id}.json`)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(statSync(join(dir, 'history')).mode & 0o777).toBe(0o700)
})

test('large and non-UTF-8 documents keep exact bytes or only size', async () => {
  const large = 'x'.repeat(PREVIEW_HISTORY_MAX_SNAPSHOT_BYTES + 1)
  const { dir, filePath, post } = await start('', large)
  const items = await submitTwo(post)
  writeFileSync(filePath, Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe]))
  await post('/api/agent/done', {
    items: items.map((item) => ({ ...item, outcome: 'fixed' })),
  })
  const history = createPreviewHistory(join(dir, 'history'), '')
  const record = history.read(history.list()[0]!.batch_id)!
  expect(record.snapshots[record.before_revision]).toEqual({
    size: large.length,
    omitted: 'too_large',
  })
  expect(record.snapshots[record.after_revision!]).toEqual({
    size: 5,
    encoding: 'base64',
    content: Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe]).toString('base64'),
  })
})

test('a history write failure does not fail the committed submission', async () => {
  const blocked = join(mkdtempSync(join(tmpdir(), 'as-preview-history-')), 'f')
  writeFileSync(blocked, 'not a directory')
  const { post, store } = await start(join(blocked, 'history'))
  const items = await submitTwo(post)
  expect(items).toHaveLength(2)
  expect(store.latestBatch()?.state).toBe('processing')
  const done = await post('/api/agent/done', {
    items: items.map((item) => ({ ...item, outcome: 'fixed' })),
  })
  expect(done.status).toBe(200)
  expect(readFileSync(blocked, 'utf8')).toBe('not a directory')
})
