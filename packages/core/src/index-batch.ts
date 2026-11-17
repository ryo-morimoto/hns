/**
 * The size of one conversation-index drain, shared by the writer and the reader.
 *
 * @remarks
 * The Session records which conversations reached the D1 index; the drain that writes them runs
 * in the Session object. Both sides bound one pass with this value, so the writer's page and the
 * drain's page cannot disagree. It is **not** the API page size: how many conversations a list
 * request may ask for is the agent's own limit.
 */
export const INDEX_DRAIN_BATCH = 50;
