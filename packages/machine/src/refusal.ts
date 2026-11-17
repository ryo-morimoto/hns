import { MACHINE_REFUSALS } from "@hns/core";

/**
 * The closed set of refusals a machine agent can answer with.
 *
 * @remarks
 * A refusal is an expected answer, not a bug: the caller is unauthenticated,
 * the request is a replay, the path is outside ROOT, or a limit is reached.
 * The code is the contract; the message is diagnostic. The list is the core model's
 * ({@link MACHINE_REFUSALS}), which the Journal's stored reasons are derived from too, so the
 * worker, this agent, and the Journal read one vocabulary.
 */
export const REFUSAL_CODES = MACHINE_REFUSALS;

/** One member of the closed refusal vocabulary. */
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/**
 * A typed refusal, so a caller branches on the code and never parses a message.
 *
 * @remarks
 * The agent answers a refused request with this code and the HTTP status that
 * `refusalStatus` assigns. An unexpected `Error` is never widened to a refusal
 * with a made-up code; it becomes `internal`.
 */
export class MachineRefusal extends Error {
  readonly code: RefusalCode;

  constructor(code: RefusalCode, message: string) {
    super(message);
    this.name = "MachineRefusal";
    this.code = code;
  }
}

/**
 * The machine's status for each refusal code.
 *
 * @remarks
 * The dependency runs server → machine, so the machine cannot read the Worker's table; this is
 * the machine's own declaration of its half of it. `too_large` is the machine's spelling of the
 * Worker's `payload_too_large` (both 413). The codes the Worker also answers with keep the same
 * status, and the machine-only ones (`stale_request`, `replayed`, `stale_connection`,
 * `path_denied`, `busy`, `deadline_exceeded`) are declared here alone. The parity test fixes
 * every value to the one the switch below replaced; adding a code without a status is a compile
 * error rather than a silent 500.
 */
const REFUSAL_STATUS = {
  unauthorized: 401,
  // A replay or a stale connection is a conflict with the state the machine holds.
  stale_request: 401,
  replayed: 409,
  stale_connection: 409,
  invalid_request: 400,
  path_denied: 400,
  forbidden: 403,
  not_found: 404,
  busy: 429,
  too_large: 413,
  deadline_exceeded: 408,
  method_not_allowed: 405,
  internal: 500,
} as const satisfies Record<RefusalCode, number>;

/**
 * The HTTP status that carries a refusal code.
 *
 * @param code - A member of the closed refusal vocabulary.
 * @returns 400, 401, 403, 404, 405, 408, 409, 413, 429, or 500.
 *
 * @remarks
 * Every member is listed in {@link REFUSAL_STATUS}, so adding a code without a
 * status is a compile error rather than a silent 500.
 */
export function refusalStatus(code: RefusalCode): number {
  return REFUSAL_STATUS[code];
}
