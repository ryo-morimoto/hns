import type { PolicyDecision, ToolId } from "@hns/core/capability";

/**
 * What the agent observes. The server turns these into persisted `Event` rows.
 *
 * @remarks
 * `at` is an ISO 8601 timestamp taken when the event is emitted. A sink is called
 * synchronously and is not awaited, so it must neither throw nor block: a throw
 * propagates into the tool or turn that emitted the event.
 *
 * `tool.call` and `tool.result` also carry the call's identity under the capability contract
 * (`docs/capability.md` §3–§4, D091): its durable `callId`, the `argsHash` / `callHash` /
 * `manifestHash` that name the exact call and the exact tool contract, the `decision` it ran under, and
 * how long it took. `argsHash` and `callHash` are hashes of the arguments, so the raw arguments are
 * never on an event. Every added field is optional: an event from a caller that does not know the
 * call's identity keeps the shape it had.
 */
export type AgentEvent =
  /** Before a tool executes. */
  | {
      readonly event: "tool.call";
      readonly at: string;
      readonly tool: string;
      /** pi-durable's id for the call, `tool:<ms>:<id>`. */
      readonly callId?: string | undefined;
      /** The tool contract's version (the manifest's `version`). */
      readonly toolVersion?: string | undefined;
      /** `sha256Hex(JCS(args))`: names the arguments without carrying them. */
      readonly argsHash?: string | undefined;
      /** `sha256Hex(JCS({v, callId, toolId, toolVersion, argsHash}))`: the identity of the call. */
      readonly callHash?: string | undefined;
      /** `sha256Hex(JCS(manifest))`: the tool contract the call was made against. */
      readonly manifestHash?: string | undefined;
      /** The decision the call runs under. Phase 1's audit sink is what persists it (`tool.call`). */
      readonly decision?: PolicyDecision | undefined;
      /** The contract's tool id, which is the tool's own name. */
      readonly toolId?: ToolId | undefined;
      /** The correlation id of the turn, when the caller supplied one. */
      readonly requestId?: string | undefined;
      /** The conversation the tool ran for, when the caller supplied one. */
      readonly conversationId?: string | undefined;
    }
  | {
      /** After it returns; `ok` is false for an isError result, and `ms` is milliseconds. */
      readonly event: "tool.result";
      readonly at: string;
      readonly tool: string;
      readonly ok: boolean;
      readonly ms: number;
      /** pi-durable's id for the call, `tool:<ms>:<id>`. */
      readonly callId?: string | undefined;
      /** The tool contract's version (the manifest's `version`). */
      readonly toolVersion?: string | undefined;
      /** `sha256Hex(JCS(args))`: names the arguments without carrying them. */
      readonly argsHash?: string | undefined;
      /** `sha256Hex(JCS({v, callId, toolId, toolVersion, argsHash}))`: the identity of the call. */
      readonly callHash?: string | undefined;
      /** `sha256Hex(JCS(manifest))`: the tool contract the call was made against. */
      readonly manifestHash?: string | undefined;
      /** The decision the call actually ran under: the allow, or the refusal and its code. */
      readonly decision?: PolicyDecision | undefined;
      /** The contract's tool id, which is the tool's own name. */
      readonly toolId?: ToolId | undefined;
      /** The awaited work only; the audit writes are not in it. */
      readonly durationMs?: number | undefined;
      /** The correlation id of the turn, when the caller supplied one. */
      readonly requestId?: string | undefined;
      /** The conversation the tool ran for, when the caller supplied one. */
      readonly conversationId?: string | undefined;
    }
  | {
      /** After a send settles; `text` is what send returned, possibly "". */
      readonly event: "agent.response";
      readonly at: string;
      readonly text: string;
      /** The correlation id of the turn, when the caller supplied one. */
      readonly requestId?: string | undefined;
      /** The conversation the turn ran for, when the caller supplied one. */
      readonly conversationId?: string | undefined;
    };

/**
 * Receives one observation as it happens.
 *
 * @remarks
 * Delivery is at most once and nothing is buffered here; the server persists what
 * it receives, so a sink that ignores an event drops it.
 */
export type AgentEventSink = (event: AgentEvent) => void;
