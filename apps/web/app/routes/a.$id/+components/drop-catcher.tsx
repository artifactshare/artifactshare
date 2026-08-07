import { useRef } from 'react'
import { cn } from '~/lib/utils'
import { hasLocalFiles } from './drag-files'

export function DropCatcher({
  active,
  onActiveChange,
  onFinish,
  onDrop,
  regressionOverlay,
}: {
  active: boolean
  onActiveChange: (active: boolean) => void
  onFinish: () => void
  onDrop: (dataTransfer: DataTransfer) => void
  regressionOverlay?: string
}) {
  const depthRef = useRef(0)

  return (
    <div
      className={cn(
        'pointer-events-auto absolute inset-0 z-20 bg-transparent',
        active && 'outline-link outline-2 -outline-offset-10 outline-dashed',
      )}
      data-regression-overlay={regressionOverlay}
      onDragEnter={(event) => {
        if (!hasLocalFiles(event.dataTransfer)) return
        event.preventDefault()
        depthRef.current += 1
        onActiveChange(true)
      }}
      onDragOver={(event) => {
        if (!hasLocalFiles(event.dataTransfer)) return
        event.preventDefault()
        onActiveChange(true)
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        depthRef.current = Math.max(0, depthRef.current - 1)
        if (depthRef.current === 0) onFinish()
      }}
      onDrop={(event) => {
        event.preventDefault()
        onDrop(event.dataTransfer)
        depthRef.current = 0
        onFinish()
      }}
    />
  )
}
