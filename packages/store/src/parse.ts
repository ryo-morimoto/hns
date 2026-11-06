import * as v from "valibot";
import type { Conversation, Event, JsonValue, Project, Task } from "@hns/core";
import {
  ConversationRowSchema,
  EventRowSchema,
  ProjectRowSchema,
  TaskRowSchema,
} from "./schemas.ts";

export function parseProject(input: JsonValue): Project {
  return v.parse(ProjectRowSchema, input);
}

export function parseConversation(input: JsonValue): Conversation {
  return v.parse(ConversationRowSchema, input);
}

export function parseTask(input: JsonValue): Task {
  return v.parse(TaskRowSchema, input);
}

export function parseEvent(input: JsonValue): Event {
  return v.parse(EventRowSchema, input);
}
