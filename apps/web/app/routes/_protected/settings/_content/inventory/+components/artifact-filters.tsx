import { Button } from '~/components/ui/button'
import { Form } from 'react-router'
import { FilterSelect } from '../../../+components/filter-select'
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
      <FilterSelect
        id="inventory-visibility-filter"
        name="visibility"
        label={t('team.inventory.filter')}
        initialValue={filters.visibility}
        className="w-36"
        options={{
          all: t('team.inventory.filter.all'),
          link: visibilityLabel('link', t),
          workspace: visibilityLabel('workspace', t),
          project: visibilityLabel('project', t),
          private: visibilityLabel('private', t),
        }}
      />
      <FilterSelect
        id="inventory-sort-filter"
        name="sort"
        label={t('team.inventory.sort')}
        initialValue={filters.sort}
        className="w-44"
        options={{
          updated: t('team.inventory.sort.updated'),
          size: t('team.inventory.sort.size'),
        }}
      />
      <Button type="submit" variant="outline" size="sm">
        {t('team.inventory.filter.apply')}
      </Button>
    </Form>
  )
}
