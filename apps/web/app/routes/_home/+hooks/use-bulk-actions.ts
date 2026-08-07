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
  // 50 件超は UI 側で実行を止める。ここは順次実行と失敗分類だけを担う。
  for (const id of ids) {
    let response: Response
    try {
      response = await operation(id)
    } catch {
      // 通信エラーは失敗扱いで選択に残す (spec の失敗分類)。残件は続行する
      result.failed.push(id)
      continue
    }
    if (response.ok || (response.status === 404 && options.notFoundIsSuccess)) {
      result.succeeded.push(id)
    } else {
      result.failed.push(id)
      if (response.status === 401 || response.status === 403) {
        // 権限問題は続行しても同じ結果のため残件を実行せず中止する。
        // 未実行分も失敗として数え、報告の分母を選択件数と一致させる
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

  // ページ送り・絞り込み・revalidate で一覧が入れ替わったら、表示されていない
  // 行の選択を落とす (見えないファイルへの一括実行や空の移動ダイアログを防ぐ)。
  // 実行中は結果反映 (成功分の解除) と競合しないよう保留する
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
        setSelected((current) =>
          current.filter((id) => !result.succeeded.includes(id)),
        )
        return result
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  return { selected, busy, toggle, clear, run }
}
