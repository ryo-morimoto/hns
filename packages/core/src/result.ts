/**
 * A fallible operation. Expected failures are returned instead of thrown, so the caller has to
 * handle them (Effect's `Effect<A, E, R>` and pi-durable's `Result` both make this the default).
 *
 * @remarks
 * Narrow with `if (result.ok)`: the success branch has `value`, the failure branch has
 * `error`. Use `never` for the side the caller cannot produce.
 */
export type Result<TValue, TError> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: TError };

/**
 * Wrap a success value.
 *
 * @param value - The value on the success branch.
 * @returns A result with `ok: true`.
 */
export function ok<TValue, TError = never>(value: TValue): Result<TValue, TError> {
  return { ok: true, value };
}

/**
 * Wrap an expected failure.
 *
 * @param error - The typed failure on the error branch.
 * @returns A result with `ok: false`.
 */
export function err<TError, TValue = never>(error: TError): Result<TValue, TError> {
  return { ok: false, error };
}
