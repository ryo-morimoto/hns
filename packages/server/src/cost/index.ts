/**
 * Cost accounting for the Durable Object turn path.
 *
 * @remarks
 * One turn is one row in D1 (`cost_turn`); the month's total is a SUM, and the monthly limits
 * and alert ratios live in one D1 row (`cost_limits`). The Session's message route calls
 * {@link CostGate.admit} before it starts a run and {@link CostGate.turn} around it. The
 * provider's own month comes from the provider gateway's budget row, not a copy.
 */
export {
  CostGaugeUnavailableError,
  CostLimitError,
  createCostGate,
  type CostBudget,
  type CostGate,
  type TurnActivity,
} from "./gate.ts";
