function unused(): never {
  throw new Error('Unused D1 fake method')
}
export function d1Statement(
  overrides: Partial<D1PreparedStatement> = {},
): D1PreparedStatement {
  const statement: D1PreparedStatement = {
    bind: () => statement,
    first: unused,
    run: unused,
    all: unused,
    raw: unused,
    ...overrides,
  }
  return statement
}
export function d1Database(overrides: Partial<D1Database> = {}): D1Database {
  return {
    prepare: unused,
    batch: unused,
    exec: unused,
    withSession: unused,
    dump: unused,
    ...overrides,
  }
}
