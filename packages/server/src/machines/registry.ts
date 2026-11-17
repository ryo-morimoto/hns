import type { MachineStatus } from "@hns/core";
import type { MachineRepository, Store } from "@hns/store";

/**
 * What the Worker may ask the machine registry: which machines exist and which key one signs
 * with.
 *
 * @remarks
 * This is the port 0147 left open. The machine verifies inbound requests with the **control-plane**
 * key; the Worker verifies a machine's own requests (a checkpoint pack is the first, 0245) with
 * the machine's **device key**, and this port is where that key comes from.
 *
 * The port is deliberately narrower than the store: a caller can look a key up but cannot enroll
 * or revoke, so verification never becomes a write. **No key is a refusal**, not an exception: a
 * missing machine, a revoked one, and a malformed stored key all answer `undefined`, and the
 * caller fails closed.
 */
export interface MachineKeyRegistry {
  /**
   * The device key a machine signs with.
   *
   * @param machineId - The `x-hns-machine` value from a signed request.
   * @returns The raw 32-byte Ed25519 public key, or `undefined` when the machine has no usable key
   * (no row, revoked, or a row whose key is not 32 bytes).
   */
  deviceKey(machineId: string): Promise<Uint8Array | undefined>;
}

/**
 * The registry port over any key source.
 *
 * @param source - Something that answers one device key per machine id.
 * @returns The port; the caller's source is not narrowed further.
 *
 * @remarks
 * The production source is the store ({@link machineKeyRegistryOver}); a test can pass a plain
 * object, so the verifier's contract is proven without a database.
 */
export function machineKeyRegistry(source: {
  deviceKey(id: string): Promise<Uint8Array | undefined>;
}): MachineKeyRegistry {
  return { deviceKey: (machineId) => source.deviceKey(machineId) };
}

/**
 * The registry over the request's store.
 *
 * @param store - The opened control database.
 * @returns The port. It reads the store's `machines` row; it never writes.
 */
export function machineKeyRegistryOver(store: Store): MachineKeyRegistry {
  const machines: MachineRepository = store.machines;
  return machineKeyRegistry(machines);
}

/**
 * Pick the machine a workspace's machine calls address.
 *
 * @param leaseMachineId - The machine holding the workspace's write lease, when it holds one.
 * @param recordedMachineId - The machine the workspace last recorded (its acquire binds it).
 * @returns The current lease holder, else the recorded machine, else `undefined`.
 *
 * @remarks
 * This is the order 0245's `#checkpointMachine()` reads: **the current lease holder, then the
 * machine the workspace recorded**. The registry is what makes "recorded" mean "an enrolled,
 * non-revoked machine": the Workspace object falls back to its own recorded id, and the registry
 * row is what says that id still has a key and a status that is not `revoked`.
 */
export function machineToCall(
  leaseMachineId: string | undefined,
  recordedMachineId: string | undefined,
): string | undefined {
  return leaseMachineId ?? recordedMachineId;
}

/**
 * Whether a status means the Worker may try the machine.
 *
 * @param status - The stored status.
 * @returns `true` for `online` and `offline`; `false` for `revoked`.
 *
 * @remarks
 * `offline` still allows a call: reachability is an observation from the last probe, and a machine
 * that was offline a minute ago may be up now. Only `revoked` is a decision that forbids the call,
 * because the machine must not be trusted any more.
 */
export function callable(status: MachineStatus): boolean {
  switch (status) {
    case "online":
    case "offline":
      return true;
    case "revoked":
      return false;
  }
}
