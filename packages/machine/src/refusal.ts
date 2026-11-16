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
 * The HTTP status that carries a refusal code.
 *
 * @param code - A member of the closed refusal vocabulary.
 * @returns 400, 401, 403, 404, 405, 408, 409, 413, 429, or 500.
 *
 * @remarks
 * Every member is listed here, so adding a code without a status is a compile
 * error rather than a silent 500.
 */
export function refusalStatus(code: RefusalCode): number {
  switch (code) {
    case "unauthorized":
      return 401;
    case "stale_request":
      return 401;
    case "replayed":
      return 409;
    case "stale_connection":
      return 409;
    case "invalid_request":
      return 400;
    case "path_denied":
      return 400;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "busy":
      return 429;
    case "too_large":
      return 413;
    case "deadline_exceeded":
      return 408;
    case "method_not_allowed":
      return 405;
    case "internal":
      return 500;
  }
  const unreachable: never = code;
  return unreachable;
}
