export function ExtTag({ label }: { label: string }) {
  return (
    <span className="text-muted-foreground border-divider flex-none rounded-[var(--r-sm)] border px-1 text-xs font-medium whitespace-nowrap">
      {label}
    </span>
  )
}
