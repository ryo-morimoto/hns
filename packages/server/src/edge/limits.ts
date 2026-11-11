/** The per-request budgets the edge enforces. */
export interface EdgeLimits {
  /** Request body size in bytes, counted after decoding. */
  readonly maxBodyBytes: number;
  /** Wall-clock budget for the whole request in milliseconds. */
  readonly maxRequestMs: number;
  /** Rows a single GraphQL request may read across all resolvers. */
  readonly maxRowsPerRequest: number;
  /** Rows a single list resolver may return. */
  readonly maxRowsPerList: number;
}

/**
 * The production budgets.
 *
 * @remarks
 * 1 MiB holds a Relay query plus ordinary variables. 10 seconds is shorter than the Workers
 * CPU limit and long enough for a few DO round trips. 500 rows per request and 100 per list
 * cover one initial screen (the PoC measured 120 conversations) without permitting an
 * unbounded fan-out.
 */
export const DEFAULT_LIMITS: EdgeLimits = {
  maxBodyBytes: 1_048_576,
  maxRequestMs: 10_000,
  maxRowsPerRequest: 500,
  maxRowsPerList: 100,
};

/** A per-request row counter shared by resolvers. */
export interface RowBudget {
  /** Rows still available; never negative. */
  readonly remaining: number;
  /**
   * Take `rows` from the budget.
   *
   * @returns True when the rows fit; false when the read would exceed the budget. A false
   * result must become a typed limit failure, not a partial list.
   */
  spend(rows: number): boolean;
}

/**
 * Create a row budget.
 *
 * @param maxRows - A non-negative integer.
 * @returns A budget that refuses to go below zero.
 * @throws RangeError when `maxRows` is not a non-negative integer or a spend is invalid.
 */
export function createRowBudget(maxRows: number): RowBudget {
  if (!Number.isInteger(maxRows) || maxRows < 0) {
    throw new RangeError("maxRows must be a non-negative integer");
  }
  let remaining = maxRows;
  return {
    get remaining() {
      return remaining;
    },
    spend(rows: number): boolean {
      if (!Number.isInteger(rows) || rows < 0) {
        throw new RangeError("rows must be a non-negative integer");
      }
      if (rows > remaining) return false;
      remaining -= rows;
      return true;
    },
  };
}
