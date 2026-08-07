import { FieldLegend, FieldSet } from '~/components/ui/field'
import { Label } from '~/components/ui/label'
import { RadioGroup, RadioGroupItem } from '~/components/ui/radio-group'
import { Inline } from '~/components/layout/inline'
import { Stack } from '~/components/layout/stack'
import { useT } from '~/hooks/use-t'
import type { ProjectBaseVisibility } from '~/lib/shareable-types'

// プロジェクトの共有範囲 (社内全員 / 関係者のみ) を選ぶラジオ。作成と編集の
// 両ダイアログで使う。name="base_visibility" で送信する。
const SCOPES: ReadonlyArray<ProjectBaseVisibility> = ['workspace', 'private']

export function ProjectScopeField({
  defaultValue = 'workspace',
}: {
  defaultValue?: ProjectBaseVisibility
}) {
  const { t } = useT()
  return (
    <FieldSet>
      <FieldLegend variant="label">{t('project.shareScope.label')}</FieldLegend>
      <RadioGroup
        name="base_visibility"
        defaultValue={defaultValue}
        className="gap-[var(--spacing-1)]"
      >
        {SCOPES.map((scope) => (
          <Label
            key={scope}
            htmlFor={`base_visibility-${scope}`}
            className="border-divider cursor-pointer rounded-[var(--r-md)] border p-[var(--spacing-2)] font-normal"
          >
            <Inline gap="2" align="start">
              <RadioGroupItem
                value={scope}
                id={`base_visibility-${scope}`}
                className="mt-0.5"
              />
              <Stack gap="0.5">
                <strong className="text-foreground text-sm">
                  {t(`project.shareScope.${scope}`)}
                </strong>
                <small className="text-muted-foreground text-xs">
                  {t(`project.shareScope.${scope}.sub`)}
                </small>
              </Stack>
            </Inline>
          </Label>
        ))}
      </RadioGroup>
    </FieldSet>
  )
}
