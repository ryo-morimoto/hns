/**
 * The Durable Object name both the edge and the resolvers use.
 *
 * @remarks
 * One workspace means one Session (D049), but the edge does not know a workspace id yet, so the
 * WebSocket forwarder and the GraphQL resolvers address the single default object.
 */
export const SESSION_NAME = "default";
