import { CopyableCodeBlock } from '~/components/app/copyable-code-block'
import { useT } from '~/hooks/use-t'
import { TeamMutedParagraph } from '~/components/form/team-muted'
import { settingsSubheadingClassName } from '~/components/form/settings-text-styles'

export function CreatedTokenPanel({
  name,
  token,
}: {
  name: string
  token: string
}) {
  const { t } = useT()

  return (
    <div className="flex flex-col gap-2" role="status">
      <h3 className={settingsSubheadingClassName}>
        {t('team.tokens.createdTitle', { name })}
      </h3>
      <TeamMutedParagraph>{t('team.tokens.createdWarning')}</TeamMutedParagraph>
      <CopyableCodeBlock
        code={token}
        name={t('team.tokens')}
        labels={{
          copy: t('team.tokens.copy'),
          copied: t('team.tokens.copied'),
          failed: t('team.tokens.copyFailed'),
        }}
        copyButtonVariant="default"
      />
    </div>
  )
}
