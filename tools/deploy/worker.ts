/**
 * The deploy project's Worker entrypoint.
 *
 * @remarks
 * The edge lives in `@hns/server`; this file re-exports it so the cf project keeps one
 * entrypoint. The relative import is deliberate: tools/deploy is not a workspace package,
 * and the edge has no runtime dependencies that need a build first.
 */
export { default } from "../../packages/server/src/edge/worker.ts";

/**
 * The Session Durable Object stub.
 *
 * @remarks
 * The binding and the export exist so the deploy config is valid before the object lands.
 * The Session DO replaces this class; until then `/ws` forwards to it and gets a 501.
 */
export class Session {
  async fetch(): Promise<Response> {
    return new Response("session not wired", { status: 501 });
  }
}
