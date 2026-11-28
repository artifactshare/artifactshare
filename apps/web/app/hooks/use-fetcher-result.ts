import { useEffect, useEffectEvent, useRef } from 'react'

export function useFetcherResult<Data>(
  fetcher: { state: string; data?: Data },
  onResult: (data: NonNullable<Data>) => void,
) {
  const result = fetcher.state === 'idle' ? fetcher.data : undefined
  const handled = useRef<Data | undefined>(undefined)
  const handle = useEffectEvent(onResult)
  useEffect(() => {
    if (result == null || handled.current === result) return
    handled.current = result
    handle(result)
  }, [result])
}
