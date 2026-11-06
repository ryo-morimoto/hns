import type { ErrorCode, RouteKey } from "@hns/core";

/** Why the call failed: the server answered an error, the network failed, or the body broke the contract. */
const API_ERROR_KINDS = ["http", "network", "contract"] as const;
export type ApiErrorKind = (typeof API_ERROR_KINDS)[number];

export interface ApiErrorInit {
  readonly route: RouteKey;
  readonly kind: ApiErrorKind;
  /** null when no response arrived (network failure). */
  readonly status: number | null;
  readonly message: string;
  readonly issues: readonly string[];
  readonly code?: ErrorCode | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly cause?: unknown;
}

/** A failed API call. Callers branch on `status` / `code`; `issues` carries the contract violation. */
export class ApiError extends Error {
  readonly route: RouteKey;
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly issues: readonly string[];
  readonly code: ErrorCode | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(init: ApiErrorInit) {
    super(init.message, { cause: init.cause });
    this.name = "ApiError";
    this.route = init.route;
    this.kind = init.kind;
    this.status = init.status;
    this.issues = init.issues;
    this.code = init.code;
    this.retryAfterMs = init.retryAfterMs;
  }
}
