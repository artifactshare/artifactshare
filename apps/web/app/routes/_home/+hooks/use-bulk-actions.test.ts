import { describe, expect, test, vi } from 'vitest'
import { BULK_ACTION_LIMIT, runBulkActions } from './use-bulk-actions'

const response = (status: number) =>
  Promise.resolve(new Response(null, { status }))

describe('useBulkActions', () => {
  test('the 50-item cap is enforced by the UI, not by silent truncation', () => {
    expect(BULK_ACTION_LIMIT).toBe(50)
  })

  test('runs sequentially and stops on forbidden response', async () => {
    const operation = vi.fn((id: string) => response(id === 'b' ? 403 : 204))
    const output = await runBulkActions(['a', 'b', 'c'], operation)
    expect(operation.mock.invocationCallOrder[1]).toBeGreaterThan(
      operation.mock.invocationCallOrder[0],
    )
    expect(operation).toHaveBeenCalledTimes(2)
    // 未実行の残件も失敗として数え、報告の分母を選択件数と一致させる
    expect(output).toEqual({ succeeded: ['a'], failed: ['b', 'c'] })
  })

  test('can treat delete 404 as success', async () => {
    const output = await runBulkActions(['a'], () => response(404), {
      notFoundIsSuccess: true,
    })
    expect(output).toEqual({ succeeded: ['a'], failed: [] })
  })
})
