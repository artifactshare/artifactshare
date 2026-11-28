import { sql, type RawBuilder } from 'kysely'

export function lowerEmail(column: string): RawBuilder<string> {
  return sql<string>`lower(${sql.ref(column)})`
}
