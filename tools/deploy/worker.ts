/**
 * Temporary Worker entrypoint for the deploy check.
 *
 * @remarks
 * 0145 replaces this with packages/server/src/edge/worker.ts. Keeping the stub here lets
 * cf deploy --dry-run build the real config before the edge exists.
 */
export class Session {
  async fetch(): Promise<Response> {
    return new Response("session not wired", { status: 501 });
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("worker not wired", { status: 501 });
  },
};
