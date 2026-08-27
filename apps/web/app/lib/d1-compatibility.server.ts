import {
  OperationNodeTransformer,
  type KyselyPlugin,
  type OperationNode,
  type OperatorNode,
  type QueryResult,
  type QueryId,
  type RawNode,
  type RootOperationNode,
  type SelectQueryNode,
  type UnaryOperationNode,
  type UnknownRow,
} from 'kysely'

const MAX_COMPOUND_OPERATIONS = 1

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

function isExists(node: OperationNode): boolean {
  if (node.kind !== 'UnaryOperationNode') return false
  const operator = (node as UnaryOperationNode).operator
  if (operator.kind !== 'OperatorNode') return false
  return (
    (operator as OperatorNode).operator === 'exists' ||
    (operator as OperatorNode).operator === 'not exists'
  )
}

class D1CompatibilityTransformer extends OperationNodeTransformer {
  protected override transformRaw(node: RawNode, queryId?: QueryId): RawNode {
    for (const [index, parameter] of node.parameters.entries()) {
      if (
        /\b(?:not\s+)?exists\s*\(?\s*$/i.test(node.sqlFragments[index] ?? '') &&
        parameter.kind === 'SelectQueryNode' &&
        flattenedOperationCount(parameter as SelectQueryNode) > 0
      ) {
        throw new Error(
          'D1 compatibility: compound SELECTs are not allowed inside EXISTS',
        )
      }
    }
    return super.transformRaw(node, queryId)
  }

  protected override transformSelectQuery(
    node: SelectQueryNode,
  ): SelectQueryNode {
    const operationCount = flattenedOperationCount(node)
    if (operationCount > MAX_COMPOUND_OPERATIONS) {
      throw new Error(
        'D1 compatibility: compound SELECTs may contain at most two terms',
      )
    }

    const insideRaw = this.nodeStack
      .slice(0, -1)
      .some((ancestor) => ancestor.kind === 'RawNode')
    if (insideRaw && operationCount > 0) {
      throw new Error(
        'D1 compatibility: compound SELECTs must not be embedded in raw SQL',
      )
    }

    const insideExists = this.nodeStack
      .slice(0, -1)
      .some((ancestor) => isExists(ancestor))
    if (insideExists && operationCount > 0) {
      throw new Error(
        'D1 compatibility: compound SELECTs are not allowed inside EXISTS',
      )
    }

    return super.transformSelectQuery(node)
  }
}

export const d1CompatibilityPlugin: KyselyPlugin = {
  transformQuery({ node, queryId }): RootOperationNode {
    return new D1CompatibilityTransformer().transformNode(node, queryId)
  },

  transformResult({ result }): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(result)
  },
}
