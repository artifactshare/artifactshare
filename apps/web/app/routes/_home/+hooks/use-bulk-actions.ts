import { useCallback, useState } from 'react'

export const BULK_ACTION_LIMIT = 50

export type BulkResult = {
  succeeded: string[]
  failed: string[]
}

export async function runBulkActions(
  ids: string[],
  operation: (id: string) => Promise<Response>,
  options: { notFoundIsSuccess?: boolean } = {},
): Promise<BulkResult> {
  const result: BulkResult = { succeeded: [], failed: [] }
  for (const id of ids) {
    let response: Response
    try {
      response = await operation(id)
    } catch {
      result.failed.push(id)
      continue
    }
    if (response.ok || (response.status === 404 && options.notFoundIsSuccess)) {
      result.succeeded.push(id)
    } else {
      result.failed.push(id)
      if (response.status === 401 || response.status === 403) {
        const index = ids.indexOf(id)
        result.failed.push(...ids.slice(index + 1))
        break
      }
    }
  }
  return result
}

export function useBulkActions(visibleIds?: string[]) {
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const visibleKey = visibleIds ? visibleIds.join('\n') : null
  const [prevVisibleKey, setPrevVisibleKey] = useState(visibleKey)
  if (visibleKey !== prevVisibleKey && !busy) {
    setPrevVisibleKey(visibleKey)
    if (visibleIds) {
      const visible = new Set(visibleIds)
      setSelected((current) => current.filter((id) => visible.has(id)))
    }
  }

  const toggle = useCallback((id: string) => {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id],
    )
  }, [])

  const clear = useCallback(() => setSelected([]), [])

  const run = useCallback(
    async (
      ids: string[],
      operation: (id: string) => Promise<Response>,
      options: { notFoundIsSuccess?: boolean } = {},
    ) => {
      setBusy(true)
      try {
        const result = await runBulkActions(ids, operation, options)
        const succeeded = new Set(result.succeeded)
        setSelected((current) => current.filter((id) => !succeeded.has(id)))
        return result
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  return { selected, busy, toggle, clear, run }
}
