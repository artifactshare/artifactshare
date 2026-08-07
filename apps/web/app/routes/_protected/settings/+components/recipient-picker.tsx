import { useEffect, useId, useState } from 'react'
import { useFetcher } from 'react-router'
import { Field, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { RadioGroup, RadioGroupItem } from '~/components/ui/radio-group'
import { useT } from '~/hooks/use-t'
import { displayName, type RecipientSearchData } from '~/lib/team-management'

export const NO_ASSET_TRANSFER = 'none'

interface RecipientPickerProps {
  excludeUserId: string
  currentUser: { id: string; name: string | null; email: string }
  value: string
  onChange: (userId: string) => void
  disabled: boolean
  allowNone: boolean
}

export function RecipientPicker({
  excludeUserId,
  currentUser,
  value,
  onChange,
  disabled,
  allowNone,
}: RecipientPickerProps) {
  const { t } = useT()
  const idPrefix = useId()
  const [query, setQuery] = useState('')
  const trimmed = query.trim()
  const fetcher = useFetcher<RecipientSearchData>()
  const { load } = fetcher

  useEffect(() => {
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: trimmed, exclude: excludeUserId })
      load(`/settings/recipients?${params}`)
    }, 250)
    return () => clearTimeout(timer)
  }, [trimmed, excludeUserId, load])

  // 前の検索語の結果を選択可能なまま残さない: 現在の検索語と一致する応答だけ使う。
  const data = fetcher.data?.query === trimmed ? fetcher.data : undefined
  const results = data?.recipients ?? []
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(
    null,
  )
  const pinnedPick =
    picked !== null &&
    picked.id === value &&
    !results.some((recipient) => recipient.id === picked.id)
      ? picked
      : null
  const failed = data?.failed === true
  const loading = !failed && (data === undefined || fetcher.state !== 'idle')
  const noResults =
    !loading && !failed && trimmed !== '' && results.length === 0
  const truncated =
    !failed && data !== undefined && data.total > data.recipients.length

  return (
    <Field>
      <FieldLabel htmlFor={`${idPrefix}-search`}>
        {t('team.members.assetTransfer.recipient')}
      </FieldLabel>
      <Input
        id={`${idPrefix}-search`}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('team.members.assetTransfer.searchPlaceholder')}
        disabled={disabled}
      />
      <RadioGroup
        value={value}
        onValueChange={(userId) => {
          const match = results.find((recipient) => recipient.id === userId)
          setPicked(match ? { id: userId, label: displayName(match) } : null)
          onChange(userId)
        }}
        disabled={disabled}
        className="gap-[var(--spacing-2)]"
      >
        <RecipientOption
          id={`${idPrefix}-self`}
          value={currentUser.id}
          label={t('team.members.assetTransfer.self', {
            name: displayName(currentUser),
          })}
        />
        {allowNone ? (
          <RecipientOption
            id={`${idPrefix}-none`}
            value={NO_ASSET_TRANSFER}
            label={t('team.members.assetTransfer.none')}
          />
        ) : null}
        {pinnedPick ? (
          <RecipientOption
            id={`${idPrefix}-picked`}
            value={pinnedPick.id}
            label={pinnedPick.label}
          />
        ) : null}
        <div className="flex max-h-40 flex-col gap-[var(--spacing-2)] overflow-y-auto">
          {results.map((recipient) => (
            <RecipientOption
              key={recipient.id}
              id={`${idPrefix}-${recipient.id}`}
              value={recipient.id}
              label={displayName(recipient)}
              detail={recipient.name ? recipient.email : undefined}
            />
          ))}
        </div>
      </RadioGroup>
      {loading ? (
        <p className="text-muted-foreground text-xs">
          {t('team.members.assetTransfer.loading')}
        </p>
      ) : null}
      {failed ? (
        <p className="text-destructive text-xs" role="alert">
          {t('team.members.assetTransfer.error')}
        </p>
      ) : null}
      {noResults ? (
        <p className="text-muted-foreground text-xs">
          {t('team.members.assetTransfer.noResults')}
        </p>
      ) : null}
      {truncated ? (
        <p className="text-muted-foreground text-xs">
          {t('team.members.assetTransfer.more', {
            count: data?.recipients.length ?? 0,
            total: data?.total ?? 0,
          })}
        </p>
      ) : null}
    </Field>
  )
}

function RecipientOption({
  id,
  value,
  label,
  detail,
}: {
  id: string
  value: string
  label: string
  detail?: string
}) {
  return (
    <div className="flex items-center gap-[var(--spacing-2)]">
      <RadioGroupItem id={id} value={value} />
      <Label htmlFor={id} className="min-w-0 font-normal">
        <span className="truncate">{label}</span>
        {detail ? (
          <span className="text-muted-foreground ml-[var(--spacing-1)] truncate text-xs">
            {detail}
          </span>
        ) : null}
      </Label>
    </div>
  )
}
