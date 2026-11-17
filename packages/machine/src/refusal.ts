/**
 * The closed set of refusals a machine agent can answer with.
 *
 * @remarks
 * A refusal is an expected answer, not a bug: the caller is unauthenticated,
 * the request is a replay, the path is outside ROOT, or a limit is reached.
 * The code is the contract; the message is diagnostic.
 */
export const REFUSAL_CODES = [
  "unauthorized",
  "stale_request",
  "replayed",
  "stale_connection",
  "invalid_request",
  "path_denied",
  "forbidden",
  "not_found",
  "busy",
  "too_large",
  "deadline_exceeded",
  "method_not_allowed",
  "internal",
] as const;

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
 * The machine cannot import the server (the dependency runs server → machine), so this is the
 * machine's side of the server's one table (`@hns/server` `failures/status.ts`): `unauthorized`,
 * `invalid_request`, `forbidden`, `not_found`, `method_not_allowed`, `internal`, and
 * `too_large` are the server's `payload_too_large` row by another spelling. The rest
 * (`stale_request`, `replayed`, `stale_connection`, `path_denied`, `busy`,
 * `deadline_exceeded`) are the machine's own: the server never answers them. The parity test
 * fixes every value to the one the switch below replaced, and `docs/observability.md` lists
 * them once. Adding a code without a status is a compile error rather than a silent 500.
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
