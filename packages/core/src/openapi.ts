import { z } from "zod";
import * as v from "./validation.ts";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Content = { "application/json": { schema: JsonValue } };
type Operation = {
  summary: string;
  requestBody?: { required: boolean; content: Content };
  responses: Record<string, { description: string; content: Content }>;
};

const json = (schema: z.ZodTypeAny): Content => {
  // toJSONSchema returns a JSON document; the round-trip narrows the library type to plain JSON.
  const schemaJson: JsonValue = JSON.parse(JSON.stringify(z.toJSONSchema(schema)));

  return { "application/json": { schema: schemaJson } };
};

const route = (
  method: string,
  path: string,
  summary: string,
  schemas: { request?: z.ZodType; response: z.ZodType },
) => ({
  method,
  path,
  summary,
  ...schemas,
});

export const routes = [
  route("GET", "/api/health", "Health and sandbox status", { response: v.HealthSchema }),
  route("GET", "/api/state", "Conversation view: messages, tasks, projects, conversations", {
    response: v.StateSchema,
  }),
  route("POST", "/api/chat", "Submit a message to a conversation", {
    request: v.ChatRequestSchema,
    response: v.ChatResponseSchema,
  }),
  route("POST", "/api/chat/abort", "Abort the active turn", {
    request: z.object({ conversationId: z.string().optional() }),
    response: z.object({ outcome: z.string() }),
  }),
  route("GET", "/api/projects", "List projects", { response: z.array(v.ProjectSchema) }),
  route("POST", "/api/projects", "Create a project", {
    request: v.ProjectCreateSchema,
    response: v.ProjectSchema,
  }),
  route("GET", "/api/tasks", "List tasks", { response: z.array(v.TaskSchema) }),
  route("POST", "/api/tasks", "Create a task", {
    request: v.TaskCreateSchema,
    response: v.TaskSchema,
  }),
  route("PATCH", "/api/tasks/{id}", "Update a task", {
    request: v.TaskUpdateSchema,
    response: v.TaskSchema,
  }),
  route("GET", "/api/conversations", "List conversations", {
    response: z.array(v.ConversationSchema),
  }),
  route("POST", "/api/conversations", "Create a conversation", {
    request: v.ConversationCreateSchema,
    response: v.ConversationSchema,
  }),
  route("PATCH", "/api/conversations/{id}", "Rename or archive a conversation", {
    request: v.ConversationUpdateSchema,
    response: v.ConversationSchema,
  }),
  route("GET", "/api/file", "Read a file", { response: v.FileReadSchema }),
  route("PUT", "/api/file", "Write a file with a version check", {
    request: v.FileWriteRequestSchema,
    response: v.MutationResultSchema,
  }),
  route("GET", "/api/events", "Recent events", { response: z.array(v.EventSchema) }),
  route("GET", "/api/metrics", "Aggregated metrics", { response: v.MetricsSchema }),
  route("GET", "/api/usage", "Usage totals", { response: v.UsageSchema }),
] as const;

export function openapiDocument() {
  const paths: Record<string, Record<string, Operation>> = {};

  for (const entry of routes) {
    const path = entry.path.replace(/:(\w+)/g, "{$1}");
    const item = paths[path] ?? {};

    paths[path] = item;
    const operation: Operation = {
      summary: entry.summary,
      responses: { "200": { description: "OK", content: json(entry.response) } },
    };

    if ("request" in entry) {
      operation.requestBody = { required: true, content: json(entry.request) };
    }

    item[entry.method.toLowerCase()] = operation;
  }

  return {
    openapi: "3.1.0",
    info: { title: "hns API", version: "0.1.0" },
    paths,
  };
}
