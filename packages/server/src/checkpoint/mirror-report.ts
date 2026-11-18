import type { DurableObjectNamespace } from "../edge/env.ts";
import type { MirrorReport, MirrorReporter } from "../do/workspace.ts";
import { REQUEST_ID_HEADER } from "../edge/correlation.ts";

/**
 * The Workspace object's way to record a mirror push that finished after its checkpoint's answer.
 *
 * @remarks
 * The push runs after the ack (0245 / 0272n), so the request that started it is already answered
 * and cannot carry the result back. The Workspace object reports through this sender, which sends
 * the same `POST /rpc/checkpoint/mirror` the object's own route serves — so the report goes
 * through the transition table and the binding's read-back, exactly as a report from any other
 * caller does, and `mirrored` is still the Worker's confirmation rather than the machine's claim.
 *
 * The binding is addressed by `idFromName(workspaceId)`, the same object the checkpoint came from.
 * The correlation id is forwarded unsigned, so the push's line in `/api/events` is filed under the
 * checkpoint request that caused it.
 *
 * A failure to send is the caller's to log: the sender throws with the status alone (never the
 * route's message, which can quote the run), and the Workspace turns that into a logged line and
 * an observation — the checkpoint was never waiting for this.
 */
export function checkpointMirrorReporter(namespace: DurableObjectNamespace): MirrorReporter {
  return async (report: MirrorReport) => {
    const headers = new Headers({ "content-type": "application/json" });
    if (report.requestId !== null) headers.set(REQUEST_ID_HEADER, report.requestId);
    const sent = await namespace.get(namespace.idFromName(report.workspaceId)).fetch(
      new Request("https://workspace.internal/rpc/checkpoint/mirror", {
        method: "POST",
        headers,
        // The route's own body: it has no field for the token, the remote, or the duration, so
        // the only things this can say are the state and its closed failure.
        body: JSON.stringify(
          report.failure === undefined
            ? { workspaceId: report.workspaceId, runId: report.runId, status: report.status }
            : {
                workspaceId: report.workspaceId,
                runId: report.runId,
                status: report.status,
                failure: report.failure,
              },
        ),
      }),
    );
    // The body is not read: the route has already written (or refused) the record, and the
    // status is all this half reports.
    await sent.body?.cancel();
    if (!sent.ok) throw new Error("the mirror report was refused (" + String(sent.status) + ")");
  };
}
