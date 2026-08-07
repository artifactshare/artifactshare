import { Button } from '~/components/ui/button'
import { Form } from 'react-router'
import { Field, FieldLabel } from '~/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { useT } from '~/hooks/use-t'
import { visibilityLabel } from './artifacts-table'

export function ArtifactFilters({
  filters,
}: {
  filters: { visibility: string; sort: string }
}) {
  const { t } = useT()
  return (
    <Form
      key={`${filters.visibility}-${filters.sort}`}
      method="get"
      className="flex flex-wrap items-end gap-[var(--spacing-3)]"
    >
      <Field className="w-36">
        <FieldLabel htmlFor="inventory-visibility-filter" className="sr-only">
          {t('team.inventory.filter')}
        </FieldLabel>
        <Select name="visibility" defaultValue={filters.visibility}>
          <SelectTrigger id="inventory-visibility-filter" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(['all', 'link', 'workspace', 'project', 'private'] as const).map(
              (v) => (
                <SelectItem key={v} value={v}>
                  {v === 'all'
                    ? t('team.inventory.filter.all')
                    : visibilityLabel(v, t)}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
      </Field>
      <Field className="w-44">
        <FieldLabel htmlFor="inventory-sort-filter" className="sr-only">
          {t('team.inventory.sort')}
        </FieldLabel>
        <Select name="sort" defaultValue={filters.sort}>
          <SelectTrigger id="inventory-sort-filter" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="updated">
              {t('team.inventory.sort.updated')}
            </SelectItem>
            <SelectItem value="size">
              {t('team.inventory.sort.size')}
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Button type="submit" variant="outline" size="sm">
        {t('team.members.filter.apply')}
      </Button>
    </Form>
  )
}
