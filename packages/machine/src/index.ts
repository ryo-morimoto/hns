export { startMachineAgent } from "./agent.ts";
// The machine's start point (0270n): `hns-machine enroll` and `hns-machine run`, exported so a test
// drives the same functions the bin script does.
export {
  CONTROL_PLANE_FILE,
  DEFAULT_CONFIG_DIR,
  DEVICE_FILE,
  EnrollmentOutputSchema,
  runCli,
  USAGE,
} from "./cli.ts";
export type { CliOutcome, EnrollmentOutput } from "./cli.ts";
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
export { REDACTED, machineEntry, redactingSink, requestIdOf, writeMachineLog } from "./log.ts";
export type { MachineLogInput, MachineLogSink } from "./log.ts";
export { runOperation } from "./operations.ts";
export type { OperationResult } from "./operations.ts";
export { createMachineExec, machineHostEnv, runExec } from "./exec.ts";
export type { MachineExec } from "./exec.ts";
export {
  createMachineSandboxEnv,
  machineHideList,
  machineSeccompFilter,
  machineShellEnv,
  readOnlyGitPaths,
  SECCOMP_ARCHES,
  seccompSupported,
} from "./sandbox.ts";
export type { MachineSandboxOptions } from "./sandbox.ts";
// The list is the core model's (the Journal's stored reasons are derived from the same one);
// re-exported so a caller importing the agent's surface reads one vocabulary.
export { MACHINE_REFUSALS as REFUSAL_CODES } from "@hns/core";
// The mirror's ref rule and push, so the Worker that issues a target and the machine that pushes
// derive the same branch name from one Run id.
export { mirrorRef } from "@hns/workspace/mirror";
export { confirmMirror, pushCheckpoint } from "@hns/workspace/mirror-push";
export type {
  MirrorConfirmRequest,
  MirrorPushOutcome,
  MirrorPushRequest,
} from "@hns/workspace/mirror-push";
// The office engine (0236): its prescan, its cache, and the pack it runs. A deployment names the
// pack and the cache; a test drives the executor without an agent.
export {
  artifactKeyOf,
  checkPackHost,
  contentTypeOf,
  engineArgv,
  loadPack,
  officeBusy,
  OfficeCache,
  OFFICE_CACHE_MAX_BYTES,
  OFFICE_CACHE_TTL_MS,
  packEnvironment,
  packReport,
  probeOfficeEngine,
  readRange,
  runEngine,
  runOfficeJob,
  scanOfficeInput,
  serveArtifact,
  sha256OfFile,
  verifyArtifactTarget,
} from "./office/index.ts";
export type {
  ArtifactResponse,
  CacheEntryFacts,
  CacheEntryMetadata,
  EngineEnvironment,
  EngineOutcome,
  EngineRun,
  OfficeEnvelope,
  OfficePack,
  OfficeScan,
  OfficeScanInput,
  OfficeScanVerdict,
  PackBindPath,
  PackBuild,
  PackHost,
  PackLoad,
  PackProblem,
} from "./office/index.ts";
export type { MachineOfficeOptions } from "./agent.ts";
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
export * from "./capability/index.ts";
