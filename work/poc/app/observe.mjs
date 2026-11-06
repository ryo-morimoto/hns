// Agent turns and tool calls, recorded from Durable's hooks.
import { defineExtension, GenerationTask, hook, ToolTask } from "@earendil-works/pi-durable";

export function createObserveExtension({ control }) {
  const starts = new Map();
  return defineExtension({
    name: "observe",
    hooks: [
      hook(GenerationTask, {
        afterResponse: (message, api) => {
          const usage = message?.usage ?? {};
          control.addEvent({
            event: "agent.response",
            conversationId: String(api.conversationId),
            level: message?.stopReason === "error" ? "warn" : "info",
            detail: {
              model: message?.provider && message?.model ? message.provider + "/" + message.model : undefined,
              stopReason: message?.stopReason,
              tokens: usage.totalTokens ?? 0,
              cost: usage.cost?.total ?? 0,
              error: message?.errorMessage,
            },
          });
        },
      }),
      hook(ToolTask, {
        beforeTool: (call, api) => {
          starts.set(api.conversationId + ":" + call.id, Date.now());
          control.addEvent({
            event: "tool.call",
            conversationId: String(api.conversationId),
            detail: { tool: call.name, callId: call.id },
          });
        },
        afterTool: (call, result, api) => {
          const key = api.conversationId + ":" + call.id;
          const started = starts.get(key);
          starts.delete(key);
          control.addEvent({
            event: "tool.result",
            conversationId: String(api.conversationId),
            level: result?.isError ? "warn" : "info",
            durationMs: started === undefined ? undefined : Date.now() - started,
            detail: {
              tool: call.name,
              callId: call.id,
              isError: Boolean(result?.isError),
              diagnostics: (result?.diagnostics ?? []).map((entry) => entry.code),
            },
          });
        },
      }),
    ],
  });
}
