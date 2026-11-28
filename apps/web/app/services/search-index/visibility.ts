import { bindAllowedIds, SearchCapacityError } from './query'

export type SearchVisibility = {
  protocol: 1
  actor: string
  ownWorkspace: boolean
  identity: boolean
  grants: string[]
  defaults: string[]
  memberships: string[]
  recency: Array<{ id: string; at: string | null }>
  now: string
  includeArchived?: boolean
  home?: boolean
  viewed?: { from?: string; to?: string }
  agent?: boolean
}

export function visibilityPredicate(input: SearchVisibility) {
  if (input.protocol !== 1) throw new SearchCapacityError()
  const bindings: Array<string | number> = []
  const value = (v: string | number) => {
    bindings.push(v)
    return '?'
  }
  const member = (column: string, ids: string[]) =>
    '(' +
    bindAllowedIds(ids)
      .map(
        (json) => `${column} IN (SELECT value FROM json_each(${value(json)}))`,
      )
      .join(' OR ') +
    ')'
  let predicate = `(${member('p.id', input.grants)}
    OR (${value(Number(input.identity))}=1 AND (p.owner=${value(input.actor)} OR (${value(Number(input.ownWorkspace))}=1 AND p.visibility='workspace')))
    OR (p.visibility='project' AND c.kind='project' AND (${member('c.id', input.defaults)}
      OR (${value(Number(input.identity))}=1 AND ((c.base='workspace' AND ${value(Number(input.ownWorkspace))}=1)
        OR (c.creator=${value(input.actor)} AND ${member('c.id', input.memberships)})))))
    OR (p.visibility='link' AND ${member(
      'p.id',
      input.recency.map((r) => r.id),
    )} AND p.suspended IS NULL
      AND (p.expires IS NULL OR (
        strftime('%Y-%m-%dT%H:%M:%S',p.expires)=substr(p.expires,1,19) AND substr(p.expires,-1)='Z'
        AND substr(p.expires,12,2) BETWEEN '00' AND '23'
        AND (length(p.expires)=20 OR (length(p.expires)>21 AND substr(p.expires,20,1)='.' AND substr(p.expires,21,length(p.expires)-21) NOT GLOB '*[^0-9]*'))
        AND julianday(p.expires)>julianday(${value(input.now)}))) AND w.links=1))`
  if (!input.includeArchived)
    predicate += " AND (c.kind IS NOT 'project' OR c.archived IS NULL)"
  if (input.home) predicate += " AND c.kind='inbox'"
  if (input.agent)
    predicate += ` AND ${value(Number(input.ownWorkspace))}=1 AND c.kind='project' AND c.archived IS NULL AND
    (p.visibility='workspace' OR (p.visibility='project' AND (c.base='workspace' OR ${member('c.id', input.defaults)})))`
  if (input.viewed) {
    const eligible = input.recency.filter(
      (r) =>
        r.at !== null &&
        (!input.viewed?.from || r.at >= input.viewed.from) &&
        (!input.viewed?.to || r.at < input.viewed.to),
    )
    predicate += ` AND ${member(
      'p.id',
      eligible.map((r) => r.id),
    )}`
  }
  if (bindings.length > 80) throw new SearchCapacityError()
  return {
    sql: `EXISTS (SELECT 1 FROM file_policy p LEFT JOIN container_policy c ON c.id=p.container LEFT JOIN workspace_policy w ON w.singleton=1 WHERE p.id=d.shareable AND (${predicate}))
      OR NOT EXISTS (SELECT 1 FROM file_policy p LEFT JOIN container_policy c ON c.id=p.container JOIN workspace_policy w ON w.singleton=1 WHERE p.id=d.shareable AND (p.container IS NULL OR c.id IS NOT NULL))`,
    bindings,
  }
}

export const LOCAL_VISIBILITY_SCHEMA = `
      CREATE TABLE IF NOT EXISTS file_policy (id TEXT PRIMARY KEY, owner TEXT NOT NULL, container TEXT, visibility TEXT NOT NULL, expires TEXT, suspended TEXT);
      CREATE TABLE IF NOT EXISTS container_policy (id TEXT PRIMARY KEY, kind TEXT NOT NULL, base TEXT, creator TEXT, archived TEXT);
      CREATE TABLE IF NOT EXISTS workspace_policy (singleton INTEGER PRIMARY KEY CHECK(singleton=1), links INTEGER NOT NULL);
`
