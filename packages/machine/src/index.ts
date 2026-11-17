export { startMachineAgent } from "./agent.ts";
export type {
  CheckpointPackSink,
  CheckpointPackUpload,
  MachineAgent,
  MachineAgentOptions,
} from "./agent.ts";
export { ConnectionGate } from "./connection.ts";
export type { Admission } from "./connection.ts";
export { containInRoot, normalizeRelative } from "./containment.ts";
export type { ContainedPath } from "./containment.ts";
export { ED25519_PUBLIC_KEY_BYTES, verificationKey } from "./control-plane.ts";
export type { ControlPlaneKeys } from "./control-plane.ts";
export { DEFAULT_LIMITS, InFlight, resolveLimits } from "./limits.ts";
export type { Limits } from "./limits.ts";
export { machineEntry, requestIdOf, writeMachineLog } from "./log.ts";
export type { MachineLogInput, MachineLogSink } from "./log.ts";
export { runOperation } from "./operations.ts";
export type { OperationResult } from "./operations.ts";
// The list is the core model's (the Journal's stored reasons are derived from the same one);
// re-exported so a caller importing the agent's surface reads one vocabulary.
export { MACHINE_REFUSALS as REFUSAL_CODES } from "@hns/core";
export { MachineRefusal, refusalStatus } from "./refusal.ts";
export type { RefusalCode } from "./refusal.ts";
export {
  bodyHash,
  DEFAULT_WINDOW_MS,
  NonceCache,
  RequestVerifier,
  signatureMessage,
  verifyRequestSignature,
} from "./signature.ts";
export type { RequestSignature, RequestVerifierOptions, VerifiableRequest } from "./signature.ts";
export * from "./wire.ts";
