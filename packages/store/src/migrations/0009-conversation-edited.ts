import type { Migration } from "./migration.ts";

const SQL = `
ALTER TABLE conversations ADD COLUMN edited_at TEXT;
`;

/**
 * The ninth schema step: a conversation row remembers that a person edited it (0271n).
 *
 * @remarks
 * Additive only (`docs/invariants.md` INV-12): one nullable column, no table rebuilt.
 *
 * The index's write direction is Object → D1 (D078): a person's rename, archive, or delete lands
 * on the row, and the object's own metadata is what a drain or a rebuild writes back. Without a
 * record of the person's write, that next write would replace the edit — a renamed conversation
 * would lose its title, an archived one would come back, and a deleted one would be resurrected —
 * on the very next turn. `edited_at` is that record: the store's human writes set it to the time
 * of the edit, and the index's upserts leave `title`, `archived`, and `deleted_at` alone while it is
 * set (`store/src/conversation-index/writer.ts` carries the one expression that says so).
 *
 * NULL is "no person edited this row", which is every row until 0271n wrote one: a row the object
 * owns is written exactly as before. `updated_at` keeps its meaning — activity and the list's
 * cursor — and is not touched by an edit; the edit's version is this column.
 */
export const migration0009: Migration = { version: 9, sql: SQL };
