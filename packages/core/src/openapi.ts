import { z } from "zod";
import * as s from "./contracts.ts";

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
  route("GET", "/api/health", "Health and sandbox status", { response: s.Health }),
  route("GET", "/api/state", "Conversation view: messages, tasks, projects, conversations", {
    response: s.State,
  }),
  route("POST", "/api/chat", "Submit a message to a conversation", {
    request: s.ChatRequest,
    response: s.ChatResponse,
  }),
  route("POST", "/api/chat/abort", "Abort the active turn", {
    request: z.object({ conversationId: z.string().optional() }),
    response: z.object({ outcome: z.string() }),
  }),
  route("GET", "/api/projects", "List projects", { response: z.array(s.Project) }),
  route("POST", "/api/projects", "Create a project", {
    request: s.ProjectCreate,
    response: s.Project,
  }),
  route("GET", "/api/tasks", "List tasks", { response: z.array(s.Task) }),
  route("POST", "/api/tasks", "Create a task", { request: s.TaskCreate, response: s.Task }),
  route("PATCH", "/api/tasks/{id}", "Update a task", { request: s.TaskUpdate, response: s.Task }),
  route("GET", "/api/conversations", "List conversations", { response: z.array(s.Conversation) }),
  route("POST", "/api/conversations", "Create a conversation", {
    request: s.ConversationCreate,
    response: s.Conversation,
  }),
  route("PATCH", "/api/conversations/{id}", "Rename or archive a conversation", {
    request: s.ConversationUpdate,
    response: s.Conversation,
  }),
  route("GET", "/api/file", "Read a file", { response: s.FileRead }),
  route("PUT", "/api/file", "Write a file with a version check", {
    request: s.FileWriteRequest,
    response: s.MutationResult,
  }),
  route("GET", "/api/events", "Recent events", { response: z.array(s.Event) }),
  route("GET", "/api/metrics", "Aggregated metrics", { response: s.Metrics }),
  route("GET", "/api/usage", "Usage totals", { response: s.Usage }),
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
