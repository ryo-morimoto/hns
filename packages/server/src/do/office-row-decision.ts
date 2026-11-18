import { isPreviewTerminal } from "@hns/core/office";
import type { OfficePreviewRow } from "./office-rows.ts";

/** How the request changes the rows for one path (0237 C2, C4). */
export type OfficeRowDecision =
  /** A row with the same `(workspaceId, path, version)` exists and is not terminal: keep it. */
  | { readonly kind: "reuse"; readonly row: OfficePreviewRow }
  /** A row for this key must be written: none existed, or a terminal one stands in the way. */
  | { readonly kind: "write" };

/**
 * Decide what a request does with the row that already exists for its key.
 *
 * @param existing - The row for this `(workspaceId, path, version)`, or undefined.
 * @param workspaceId - The workspace the request acts in.
 * @param path - The path the request names.
 * @param version - The version the request names.
 * @returns `reuse` for a `queued` / `generating` / `stale` row (C2), `write` otherwise.
 *
 * @remarks
 * **Idempotency is per `(path, version)`, and it ends at a terminal state.** Asking twice for the
 * same version while it is `queued` must not queue it twice (C2: one row, one alarm), and asking
 * after it is `ready` must not regenerate it. But asking again after `disabled`, `unsupported`,
 * or `failed` is a person saying "try again" — after a pack was installed, or after a failure
 * they want retried — so that row is replaced rather than reused.
 *
 * A row with another workspace or another version is neither: the caller deletes it with the rest
 * of the path's old versions (C4) and this decision is not its business.
 */
export function officeRowDecision(
  existing: OfficePreviewRow | undefined,
  workspaceId: string,
  path: string,
  version: string,
): OfficeRowDecision {
  if (
    existing === undefined ||
    existing.workspaceId !== workspaceId ||
    existing.path !== path ||
    existing.version !== version
  ) {
    return { kind: "write" };
  }
  if (isPreviewTerminal(existing.status)) return { kind: "write" };
  return { kind: "reuse", row: existing };
}
