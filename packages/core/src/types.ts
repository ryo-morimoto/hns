// Domain vocabulary shared by the contracts and the app.
// Wire types are inferred from the zod contracts; these are the closed sets they refer to.

export const TASK_STATUSES = ["todo", "doing", "done", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RUN_STATUSES = ["queued", "running", "waiting", "done", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const AUTH_MODES = ["token", "tailscale", "passkey", "none"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const EVENT_LEVELS = ["info", "warn", "error"] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

export const MESSAGE_ROLES = ["user", "assistant", "tool"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];
