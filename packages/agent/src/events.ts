/** What the agent observes. The server turns these into persisted \`Event\` rows. */
export type AgentEvent =
  | { readonly event: "tool.call"; readonly at: string; readonly tool: string }
  | {
      readonly event: "tool.result";
      readonly at: string;
      readonly tool: string;
      readonly ok: boolean;
      readonly ms: number;
    }
  | { readonly event: "agent.response"; readonly at: string; readonly text: string };

export type AgentEventSink = (event: AgentEvent) => void;
