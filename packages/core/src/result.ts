// A fallible operation. Expected failures are returned instead of thrown, so the caller has to
// handle them (Effect's `Effect<A, E, R>` and pi-durable's `Result` both make this the default).
export type Result<TValue, TError> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: TError };

export function ok<TValue, TError = never>(value: TValue): Result<TValue, TError> {
  return { ok: true, value };
}

export function err<TError, TValue = never>(error: TError): Result<TValue, TError> {
  return { ok: false, error };
}
