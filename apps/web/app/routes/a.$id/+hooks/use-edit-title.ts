import { useCallback, useRef, useState } from 'react'
import { useRevalidator } from 'react-router'

export function useEditTitle(
  shareableId: string,
  initialValue: string | null,
): {
  isEditing: boolean
  value: string
  start: () => void
  cancel: () => void
  change: (value: string) => void
  submit: () => Promise<void>
} {
  const [isEditing, setIsEditing] = useState(false)
  const [value, setValue] = useState(initialValue ?? '')
  const skipNextSubmitRef = useRef(false)
  const revalidator = useRevalidator()

  const start = useCallback(() => {
    setValue(initialValue ?? '')
    skipNextSubmitRef.current = false
    setIsEditing(true)
  }, [initialValue])

  const cancel = useCallback(() => {
    setValue(initialValue ?? '')
    skipNextSubmitRef.current = true
    setIsEditing(false)
  }, [initialValue])

  const change = useCallback((nextValue: string) => {
    setValue(nextValue)
  }, [])

  const submit = useCallback(async () => {
    if (skipNextSubmitRef.current) {
      skipNextSubmitRef.current = false
      return
    }
    const trimmed = value.trim()
    const response = await fetch(`/api/shareables/${shareableId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        titleOverride: trimmed === '' ? null : trimmed,
      }),
    })
    if (!response.ok) throw new Error('Failed to update title override')
    // input unmount に伴う合成 blur が submit を再発火させても二重 PATCH に
    // ならないよう保険。次回 start() で false に戻る。
    skipNextSubmitRef.current = true
    setIsEditing(false)
    revalidator.revalidate()
  }, [revalidator, shareableId, value])

  return { isEditing, value, start, cancel, change, submit }
}
