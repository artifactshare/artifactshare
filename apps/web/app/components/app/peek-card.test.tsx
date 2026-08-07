import { beforeEach, describe, expect, test, vi } from 'vitest'
import { loadPeek } from './peek-data'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
const notFound = () => Promise.resolve({ ok: false })

describe('loadPeek', () => {
  beforeEach(async () => {
    // 前のテストのキャッシュを pathname 変化で捨ててから呼び出し記録をリセットする
    fetchMock.mockImplementation(() => notFound())
    await loadPeek(
      'shareable',
      `reset-${Math.random()}`,
      `/reset-${Math.random()}`,
    )
    fetchMock.mockReset()
  })

  test('fetches immediately and returns the payload', async () => {
    fetchMock.mockImplementation(() => ok({ id: 's1', title: 'Doc' }))
    const data = await loadPeek('shareable', 's1', '/files')
    expect(fetchMock).toHaveBeenCalledWith('/api/peek/shareable/s1')
    expect(data).toEqual({ id: 's1', title: 'Doc' })
  })

  test('caches by id within the same page (single fetch)', async () => {
    fetchMock.mockImplementation(() => ok({ id: 's1' }))
    await loadPeek('shareable', 's1', '/files')
    await loadPeek('shareable', 's1', '/files')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('concurrent hovers share one in-flight request', async () => {
    fetchMock.mockImplementation(() => ok({ id: 'p1' }))
    const [a, b] = await Promise.all([
      loadPeek('project', 'p1', '/projects'),
      loadPeek('project', 'p1', '/projects'),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).toEqual({ id: 'p1' })
    expect(b).toEqual({ id: 'p1' })
  })

  test('404 resolves to null and is negatively cached (no retry)', async () => {
    fetchMock.mockImplementation(() => notFound())
    expect(await loadPeek('shareable', 'gone', '/recent')).toBeNull()
    expect(await loadPeek('shareable', 'gone', '/recent')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('page transition clears the cache and refetches', async () => {
    fetchMock.mockImplementation(() => ok({ id: 's1' }))
    await loadPeek('shareable', 's1', '/files')
    await loadPeek('shareable', 's1', '/recent')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
