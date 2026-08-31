import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import { AuthorAvatar } from '~/components/app/author-avatar'
import { parseGrantEmails } from '~/lib/grant-emails'
import {
  isRecipientSuggestionQuery,
  type RecipientSuggestion,
  type RecipientSuggestionContext,
} from '~/lib/recipient-suggestions'
import { getOwnerInitial } from '~/lib/user'
import { cn } from '~/lib/utils'

type SearchState =
  | { status: 'idle'; candidates: RecipientSuggestion[] }
  | { status: 'loading'; candidates: RecipientSuggestion[] }
  | { status: 'ready'; candidates: RecipientSuggestion[] }
  | { status: 'error'; candidates: RecipientSuggestion[] }

export function RecipientSuggestionInput({
  className,
  value,
  disabled,
  context,
  excludedEmails,
  ownerEmail,
  onChange,
  onCommit,
  labels,
}: {
  className?: string
  value: string
  disabled: boolean
  context: RecipientSuggestionContext
  excludedEmails: ReadonlyArray<string>
  ownerEmail?: string | null
  onChange: (value: string) => void
  onCommit: (value?: string) => void
  labels: {
    placeholder: string
    loading: string
    empty: string
    count: (count: number) => string
  }
}) {
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const generation = useRef(0)
  const [focused, setFocused] = useState(false)
  const [active, setActive] = useState(-1)
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null)
  const [search, setSearch] = useState<SearchState>({
    status: 'idle',
    candidates: [],
  })
  const contextKind = context.kind
  const contextId = context.kind === 'upload' ? null : context.id
  const requestBody = JSON.stringify({
    query: value,
    pendingEmails: excludedEmails,
    context:
      contextKind === 'upload'
        ? { kind: 'upload' }
        : { kind: contextKind, id: contextId },
  })
  const qualified = isRecipientSuggestionQuery(value)
  const open =
    focused &&
    qualified &&
    (search.status === 'loading' || search.status === 'ready') &&
    dismissedQuery !== value

  useEffect(() => {
    const current = ++generation.current
    if (!isRecipientSuggestionQuery(value) || disabled) {
      setSearch({ status: 'idle', candidates: [] })
      setActive(-1)
      return
    }
    const controller = new AbortController()
    setSearch({ status: 'loading', candidates: [] })
    setActive(-1)
    const timer = window.setTimeout(() => {
      void fetch('/api/share-recipient-candidates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error('recipient suggestion failed')
          return (await response.json()) as {
            candidates: RecipientSuggestion[]
          }
        })
        .then(({ candidates }) => {
          if (generation.current !== current) return
          setSearch({ status: 'ready', candidates })
          setActive(candidates.length > 0 ? 0 : -1)
        })
        .catch(() => {
          if (controller.signal.aborted || generation.current !== current)
            return
          setSearch({ status: 'error', candidates: [] })
          setActive(-1)
        })
    }, 200)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [disabled, requestBody, value])

  const choose = (candidate: RecipientSuggestion) => {
    generation.current += 1
    setSearch({ status: 'idle', candidates: [] })
    setActive(-1)
    onCommit(candidate.email)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const validEmailInput = parseGrantEmails(value, ownerEmail).length > 0
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' && open) {
      event.preventDefault()
      setActive((current) =>
        Math.min(search.candidates.length - 1, current + 1),
      )
      return
    }
    if (event.key === 'ArrowUp' && open) {
      event.preventDefault()
      setActive((current) => Math.max(0, current - 1))
      return
    }
    if (
      event.key === 'Enter' &&
      open &&
      active >= 0 &&
      search.candidates[active]
    ) {
      event.preventDefault()
      choose(search.candidates[active])
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      setDismissedQuery(value)
      setActive(-1)
      return
    }
    if (
      validEmailInput &&
      (event.key === 'Enter' || event.key === ',' || event.key === ' ')
    ) {
      event.preventDefault()
      onCommit()
    }
  }

  return (
    <PopoverPrimitive.Root open={open} modal={false}>
      <PopoverPrimitive.Anchor asChild>
        <input
          ref={inputRef}
          type="text"
          className={className}
          role="combobox"
          aria-label={labels.placeholder}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={
            open && active >= 0 ? `${listId}-${active}` : undefined
          }
          aria-autocomplete="list"
          placeholder={labels.placeholder}
          value={value}
          disabled={disabled}
          onFocus={() => {
            setFocused(true)
            setDismissedQuery(null)
          }}
          onChange={(event) => {
            setDismissedQuery(null)
            onChange(event.currentTarget.value)
          }}
          onBlur={() => {
            setFocused(false)
            if (validEmailInput) onCommit()
          }}
          onKeyDown={handleKeyDown}
        />
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={12}
          avoidCollisions
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="border-border bg-popover text-popover-foreground z-60 w-[var(--radix-popover-trigger-width)] min-w-64 overflow-hidden rounded-[var(--r-md)] border shadow-lg"
        >
          <div
            id={listId}
            role="listbox"
            className="max-h-72 overflow-y-auto p-1 max-sm:max-h-48"
          >
            {search.status === 'loading' ? (
              <p className="text-muted-foreground px-3 py-2 text-sm">
                {labels.loading}
              </p>
            ) : search.status === 'ready' && search.candidates.length === 0 ? (
              <p className="text-muted-foreground px-3 py-2 text-sm">
                {labels.empty}
              </p>
            ) : (
              search.candidates.map((candidate, index) => (
                <button
                  key={candidate.email}
                  id={`${listId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  tabIndex={-1}
                  className={cn(
                    'flex min-h-11 w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left outline-none',
                    index === active && 'bg-muted',
                  )}
                  onPointerMove={() => setActive(index)}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => choose(candidate)}
                >
                  <AuthorAvatar
                    id={candidate.user?.id ?? candidate.email}
                    image={candidate.user?.image ?? null}
                    initial={getOwnerInitial(
                      candidate.user?.name ?? candidate.displayName,
                      candidate.email,
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {candidate.user?.name ??
                        candidate.displayName ??
                        candidate.email}
                    </span>
                    {candidate.user?.name || candidate.displayName ? (
                      <RecipientEmail email={candidate.email} />
                    ) : null}
                  </span>
                </button>
              ))
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
      <span className="sr-only" aria-live="polite">
        {search.status === 'loading'
          ? labels.loading
          : search.status === 'ready'
            ? labels.count(search.candidates.length)
            : ''}
      </span>
    </PopoverPrimitive.Root>
  )
}

function RecipientEmail({ email }: { email: string }) {
  const at = email.lastIndexOf('@')
  if (at <= 0) {
    return (
      <span className="text-muted-foreground block truncate text-xs">
        {email}
      </span>
    )
  }
  return (
    <span className="text-muted-foreground flex min-w-0 text-xs">
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
        {email.slice(0, at)}
      </span>
      <span className="shrink-0">{email.slice(at)}</span>
    </span>
  )
}
