import {
  OperationNodeTransformer,
  SqliteAdapter,
  type KyselyPlugin,
  type OperationNode,
  type PrimitiveValueListNode,
  type QueryResult,
  type QueryId,
  type RootOperationNode,
  type SelectQueryNode,
  type UnknownRow,
  type ValueNode,
} from 'kysely'
import { D1Dialect } from 'kysely-d1'

class ConcurrentD1Adapter extends SqliteAdapter {
  override get supportsMultipleConnections(): boolean {
    // Isolate-shared Kysely must not share request-created lock promises.
    // D1 connections are stateless, so concurrent acquisition needs no mutex.
    return true
  }
}

export class ConcurrentD1Dialect extends D1Dialect {
  override createAdapter(): SqliteAdapter {
    return new ConcurrentD1Adapter()
  }
}

const MAX_COMPOUND_OPERATIONS = 4
const MAX_BOUND_PARAMETERS = 100

function flattenedOperationCount(node: SelectQueryNode): number {
  return (node.setOperations ?? []).reduce(
    (count, operation) =>
      count +
      1 +
      (operation.expression.kind === 'SelectQueryNode'
        ? flattenedOperationCount(operation.expression as SelectQueryNode)
        : 0),
    0,
  )
}

class D1CompatibilityTransformer extends OperationNodeTransformer {
  #boundParameterCount = 0

  assertCompatible(node: OperationNode, queryId?: QueryId): OperationNode {
    const transformed = this.transformNode(node, queryId)
    if (this.#boundParameterCount > MAX_BOUND_PARAMETERS) {
      throw new Error(
        `D1 compatibility: queries may bind at most ${MAX_BOUND_PARAMETERS} parameters`,
      )
    }
    return transformed
  }

  protected override transformValue(
    node: ValueNode,
    queryId?: QueryId,
  ): ValueNode {
    if (!node.immediate) this.#boundParameterCount += 1
    return super.transformValue(node, queryId)
  }

  protected override transformPrimitiveValueList(
    node: PrimitiveValueListNode,
    queryId?: QueryId,
  ): PrimitiveValueListNode {
    this.#boundParameterCount += node.values.length
    return super.transformPrimitiveValueList(node, queryId)
  }

  protected override transformSelectQuery(
    node: SelectQueryNode,
  ): SelectQueryNode {
    const operationCount = flattenedOperationCount(node)
    if (operationCount > MAX_COMPOUND_OPERATIONS) {
      throw new Error(
        'D1 compatibility: compound SELECTs may contain at most five terms',
      )
    }

    return super.transformSelectQuery(node)
  }
}

export const d1CompatibilityPlugin: KyselyPlugin = {
  transformQuery({ node, queryId }): RootOperationNode {
    return new D1CompatibilityTransformer().assertCompatible(
      node,
      queryId,
    ) as RootOperationNode
  },

  transformResult({ result }): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(result)
  },
}
