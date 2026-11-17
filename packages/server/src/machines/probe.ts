import type { Machine } from "@hns/core";
import type { MachineProbeObservation } from "@hns/store";
import { createMachineTransport, type MachineTransport } from "./transport.ts";

/**
 * The reachability probe: ask one machine for its health with a control-plane-signed call, and
 * record what the answer says (0148 / D087 U-03).
 *
 * @remarks
 * **The operation is `{"op":"health"}` on `/rpc`**, not a separate `GET /health` route. 0147's
 * agent answers `/rpc` only (any other path is `not_found`), and `health` is one of its
 * operations: it returns the ROOT and the pid, and it is the operation the machine already proves
 * is signed and in the clock window. A probe that needs a different route would be a second
 * contract for the same question.
 *
 * **The result is an observation, not a decision.** A successful answer is `online` and a fresh
 * `last_seen`; a failure is `offline`. The registry throttles the write (30 seconds), so reading
 * a list repeatedly does not amplify writes. A revoked machine is never probed: it is not
 * reachable in the sense that matters, and a probe must not move its status.
 */

/** How long one probe may take. The transport default is the same number (D087). */
export const MACHINE_PROBE_TIMEOUT_MS = 3_000;

/** The body every probe sends: the agent's health operation. */
export const MACHINE_HEALTH_BODY = new TextEncoder().encode(JSON.stringify({ op: "health" }));

/**
 * What a probe needs from the registry: one throttled write.
 *
 * @remarks
 * A narrow port rather than the whole repository: a probe observes, and giving it the ability to
 * enroll or revoke would let a reachability read become a write nobody asked for.
 */
export interface MachineProbeWriter {
  /** Record one observation; the registry decides whether the throttle allows a write. */
  recordProbe(id: string, observation: MachineProbeObservation): Promise<boolean>;
}

/** What probing needs: the registry write, the transport, and the control-plane key. */
export interface MachineProbeOptions {
  /** The registry; its `recordProbe` is the throttled write. */
  readonly machines: MachineProbeWriter;
  /** The control-plane seed (base64url), from `HNS_CONTROL_PLANE_KEY`. */
  readonly controlPlaneKey: string;
  /** The transport; production uses {@link createMachineTransport}. */
  readonly transport?: MachineTransport | undefined;
  /** The clock in epoch milliseconds; tests pass a fixed one. */
  readonly now?: (() => number) | undefined;
  /** The correlation id of the request that triggered the probe, forwarded to the machine. */
  readonly requestId?: string | undefined;
  /** The deadline of the request that triggered the probe, so a slow probe cannot outlive it. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Probe one machine and record the observation.
 *
 * @param machine - The machine to probe; a revoked one is not probed.
 * @param options - The registry, the key, the transport, and the clock.
 * @returns What was observed, and whether the registry wrote it.
 *
 * @remarks
 * The probe fails closed: a missing key, an unreachable host, a refusal, or a deadline is `offline`
 * and nothing is stored as reachable. A probe never throws for an expected failure, because a
 * reachability observation must not fail the list read that asked for it.
 */
export async function probeMachine(
  machine: Machine,
  options: MachineProbeOptions,
): Promise<{ readonly observation: MachineProbeObservation; readonly written: boolean }> {
  const clock = options.now ?? (() => Date.now());
  if (machine.status === "revoked") {
    return { observation: { reachable: false, at: clock() }, written: false };
  }
  const transport = options.transport ?? createMachineTransport();
  const answer = await transport.call({ hostname: machine.hostname }, MACHINE_HEALTH_BODY, {
    controlPlaneKey: options.controlPlaneKey,
    machineId: machine.id,
    requestId: options.requestId,
    signal: options.signal,
    now: clock,
    timeoutMs: MACHINE_PROBE_TIMEOUT_MS,
  });
  const observation: MachineProbeObservation = {
    reachable: answer.ok,
    at: clock(),
  };
  const written = await options.machines.recordProbe(machine.id, observation);
  return { observation, written };
}

/**
 * Probe every machine a list read is about to show.
 *
 * @param machines - The machines to probe.
 * @param options - The probe options.
 * @returns Nothing; each probe records its own observation.
 *
 * @remarks
 * Probes run **concurrently**, each bounded by the transport's deadline, so a list does not pay
 * one timeout per dead machine in sequence. The list is the thing the caller waits for; the
 * registry writes are the delayed effect D087 describes.
 */
export async function probeAll(
  machines: readonly Machine[],
  options: MachineProbeOptions,
): Promise<void> {
  await Promise.all(machines.map(async (machine) => await probeMachine(machine, options)));
}
