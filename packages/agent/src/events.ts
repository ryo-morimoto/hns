/**
 * What the agent observes. The server turns these into persisted `Event` rows.
 *
 * @remarks
 * `at` is an ISO 8601 timestamp taken when the event is emitted. A sink is called
 * synchronously and is not awaited, so it must neither throw nor block: a throw
 * propagates into the tool or turn that emitted the event.
 */
export type AgentEvent =
  /** Before a tool executes. */
  | {
      readonly event: "tool.call";
      readonly at: string;
      readonly tool: string;
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
