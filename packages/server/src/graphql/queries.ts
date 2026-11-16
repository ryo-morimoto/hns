import { Kind, type DocumentNode, type SelectionSetNode } from "graphql";

/** The limits one GraphQL request must stay within, before any resolver runs. */
export interface GraphQLRequestLimits {
  /** UTF-8 bytes of the query text. */
  readonly maxBytes: number;
  /** Nesting depth of the selection sets. */
  readonly maxDepth: number;
  /** Field selections, with a fragment counted once per spread. */
  readonly maxComplexity: number;
}

/**
 * The production query limits.
 *
 * @remarks
 * A hand-written screen query is around 2 KiB, so 8 KiB allows large fragments without letting
 * parse and validation cost grow unbounded. The model nests two levels (Query, list, type); 8
 * leaves room for wrappers and refuses recursive shapes. A screen selects about 30 fields, so
 * 500 is an order of magnitude of headroom while still blocking a fan-out query.
 */
export const DEFAULT_GRAPHQL_LIMITS: GraphQLRequestLimits = {
  maxBytes: 8_192,
  maxDepth: 8,
  maxComplexity: 500,
};

/** A query that is valid GraphQL but over budget. */
export class GraphQLRequestLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphQLRequestLimitError";
  }
}

/**
 * The deepest nesting reachable from one selection set.
 *
 * @internal
 * @remarks
 * Fragment cycles are a validation error; the visiting set only stops this walk from looping
 * before validation reports them.
 */
function depthOf(
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, SelectionSetNode>,
  visiting: Set<string>,
): number {
  let deepest = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const below =
        selection.selectionSet === undefined
          ? 0
          : depthOf(selection.selectionSet, fragments, visiting);
      deepest = Math.max(deepest, 1 + below);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      deepest = Math.max(deepest, depthOf(selection.selectionSet, fragments, visiting));
    } else {
      const name = selection.name.value;
      const fragment = fragments.get(name);
      if (fragment === undefined || visiting.has(name)) continue;
      visiting.add(name);
      deepest = Math.max(deepest, depthOf(fragment, fragments, visiting));
      visiting.delete(name);
    }
  }
  return deepest;
}

/**
 * The field selections reachable from one selection set.
 *
 * @internal
 * @remarks
 * A fragment counts once per spread because the server executes it each time. The walk stops at
 * `cap` so a deeply repeated fragment cannot make the check itself expensive.
 */
function complexityOf(
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, SelectionSetNode>,
  visiting: Set<string>,
  cap: number,
): number {
  let total = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      total += 1;
      if (selection.selectionSet !== undefined) {
        total += complexityOf(selection.selectionSet, fragments, visiting, cap - total);
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      total += complexityOf(selection.selectionSet, fragments, visiting, cap - total);
    } else {
      const name = selection.name.value;
      const fragment = fragments.get(name);
      if (fragment === undefined || visiting.has(name)) continue;
      visiting.add(name);
      total += complexityOf(fragment, fragments, visiting, cap - total);
      visiting.delete(name);
    }
    if (total >= cap) return total;
  }
  return total;
}

/** Index every fragment definition by name. */
function fragmentsOf(document: DocumentNode): ReadonlyMap<string, SelectionSetNode> {
  const fragments = new Map<string, SelectionSetNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition.selectionSet);
    }
  }
  return fragments;
}

/**
 * Refuse a query text over the byte budget.
 *
 * @param query - The query text, measured in UTF-8 bytes.
 * @param limits - The budgets; production uses {@link DEFAULT_GRAPHQL_LIMITS}.
 * @throws GraphQLRequestLimitError when the text is too large.
 *
 * @remarks
 * Separate from {@link assertWithinLimits} so the face can refuse a large body before it pays
 * for `parse`.
 */
export function assertWithinBytes(
  query: string,
  limits: GraphQLRequestLimits = DEFAULT_GRAPHQL_LIMITS,
): void {
  const bytes = new TextEncoder().encode(query).length;
  if (bytes > limits.maxBytes) {
    throw new GraphQLRequestLimitError(
      "The query is " + String(bytes) + " bytes; the limit is " + String(limits.maxBytes) + ".",
    );
  }
}

/**
 * Refuse a query that is larger, deeper, or more expensive than the limits allow.
 *
 * @param query - The query text, measured in UTF-8 bytes.
 * @param document - The parsed query; the walk reads the same nodes the executor will.
 * @param limits - The budgets; production uses {@link DEFAULT_GRAPHQL_LIMITS}.
 * @throws GraphQLRequestLimitError when any budget is exceeded.
 *
 * @remarks
 * Runs after parsing (a byte limit needs the text) and before validation and execution, so an
 * oversized query never costs a resolver.
 */
export function assertWithinLimits(
  query: string,
  document: DocumentNode,
  limits: GraphQLRequestLimits = DEFAULT_GRAPHQL_LIMITS,
): void {
  assertWithinBytes(query, limits);
  const fragments = fragmentsOf(document);
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
    const depth = depthOf(definition.selectionSet, fragments, new Set());
    if (depth > limits.maxDepth) {
      throw new GraphQLRequestLimitError(
        "The query reaches depth " +
          String(depth) +
          "; the limit is " +
          String(limits.maxDepth) +
          ".",
      );
    }
    const complexity = complexityOf(
      definition.selectionSet,
      fragments,
      new Set(),
      limits.maxComplexity + 1,
    );
    if (complexity > limits.maxComplexity) {
      throw new GraphQLRequestLimitError(
        "The query selects more than " + String(limits.maxComplexity) + " fields.",
      );
    }
  }
}
