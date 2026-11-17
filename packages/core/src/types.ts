// The model. Types are the source of truth. Wire projections are generated from these
// (`@hns/core/graphql`); request and response envelopes belong to the surface that serves them.

declare const brand: unique symbol;
/**
 * A nominal wrapper: two ids of different kinds cannot be swapped, although both are strings at
 * runtime. Brands are built only where an untrusted string crosses a boundary.
 *
 * @remarks
 * The brand exists only in the type system; it adds no runtime check. Do not cast a raw string to
 * a branded type outside `codecs.ts`.
 */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Mixing a project id with a conversation id would address the wrong row, so both are branded. */
export type ProjectId = Brand<string, "ProjectId">;

/** A conversation id. Branded so it cannot be passed where a project id is expected. */
export type ConversationId = Brand<string, "ConversationId">;

/**
 * The closed task vocabulary.
 *
 * @remarks
 * Declaration order is preserved by the GraphQL enum. Adding a member requires updating every
 * exhaustive `switch` over `TaskStatus`.
 */
export const TASK_STATUSES = ["todo", "doing", "done", "blocked"] as const;
/** One task state. */
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * The closed workflow run vocabulary.
 *
 * @remarks
 * Legal movement is defined only in `workflow.ts`; `done` and `failed` are terminal.
 */
export const WORKFLOW_RUN_STATUSES = ["queued", "running", "waiting", "done", "failed"] as const;
/** One workflow run state. */
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

/**
 * The closed workflow node vocabulary.
 *
 * @remarks
 * Legal movement is defined only in `workflow.ts`; `waiting` may resume at `running`, and
 * `done` and `failed` are terminal.
 */
export const WORKFLOW_NODE_STATUSES = ["pending", "running", "waiting", "done", "failed"] as const;
/** One workflow node state. */
export type WorkflowNodeStatus = (typeof WORKFLOW_NODE_STATUSES)[number];

/**
 * The closed automation firing vocabulary.
 *
 * @remarks
 * A firing starts at `running` and moves once to `done` or `failed`; `skipped` is terminal
 * already.
 */
export const AUTOMATION_FIRING_STATUSES = ["running", "done", "failed", "skipped"] as const;
/** One automation firing state. */
export type AutomationFiringStatus = (typeof AUTOMATION_FIRING_STATUSES)[number];

/** Severity of one event in the audit log. */
export const EVENT_LEVELS = ["info", "warn", "error"] as const;
/** One event severity. */
export type EventLevel = (typeof EVENT_LEVELS)[number];

/**
 * The closed event vocabulary.
 *
 * @remarks
 * Names are `area.action` strings persisted in the event log, so renaming or removing one
 * invalidates stored rows. Add a member instead of repurposing an existing name.
 */
export const EVENT_NAMES = [
  "server.start",
  "auth.denied",
  "http",
  "http.error",
  "do.rpc",
  "fs.op",
  "chat.submitted",
  "chat.settled",
  "chat.aborted",
  "chat.rate_limited",
  "chat.budget_exceeded",
  "agent.response",
  "tool.call",
  "tool.result",
  "conversation.created",
  "conversation.updated",
  "conversation.deleted",
  "project.created",
  "project.renamed",
  "task.created",
  "task.updated",
  "secret.put",
  "secret.delete",
  "file.write",
  "workflow.created",
  "workflow.updated",
  "workflow.run.started",
  "workflow.run.finished",
  "workflow.run.failed",
  "workflow.node.started",
  "workflow.node.finished",
  "workflow.node.waiting",
  "index.rebuilt",
  "index.drain.failed",
  "index.state.failed",
  "automation.created",
  "automation.fired",
  "automation.skipped",
  "automation.finished",
] as const;
/** One event name. */
export type EventName = (typeof EVENT_NAMES)[number];

/**
 * A value in the JSON data model: string, number, boolean, null, array, or object.
 *
 * @remarks
 * Event detail is serialized with `JSON.stringify`, so it must stay JSON-safe and free of
 * secrets; the log keeps identifiers, statuses, and counts, never bodies or tokens.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { [key: string]: JsonValue };

/**
 * The closed egress vocabulary for a project (D080 U-06).
 *
 * @remarks
 * `inherit` follows the machine's network setting, `deny` closes it, and `allowlist` reserves a
 * domain list that the machine's proxy will enforce (0147 / 0194; until then it is treated as
 * `deny`). The model stores the policy; enforcement is the machine's.
 */
export const PROJECT_EGRESS_POLICIES = ["inherit", "deny", "allowlist"] as const;
/** One egress policy. */
export type ProjectEgress = (typeof PROJECT_EGRESS_POLICIES)[number];

/** A project: the owner of conversations, tasks, workflows, and automations. */
export interface Project {
  id: ProjectId;
  name: string;
  /**
   * The project's directory below the machine's ROOT; empty means the ROOT itself.
   *
   * @remarks
   * A POSIX path that is already canonical: no absolute path, `..`, `.`, empty segment,
   * backslash, NUL, or `.hns` segment. The model checks that lexically; the machine checks
   * whether the real path stays below its ROOT. Fixed when the project is created.
   */
  workspace_root: string;
  /**
   * The directory the agent starts in, relative to the machine's ROOT.
   *
   * @remarks
   * Equal to {@link Project.workspace_root}: the project root is the agent's cwd. It is a
   * separate field so a surface can name the cwd without reading the storage name, and no API
   * changes one without the other.
   */
  agent_cwd: string;
  /**
   * The project's network egress policy.
   *
   * @remarks
   * Fixed at creation to `inherit`; choosing `deny` for an untrusted project is a later
   * mutation. The machine enforces it (0147 / 0194).
   */
  egress: ProjectEgress;
  /** ISO 8601 (UTC), set by the store. */
  created_at: string;
}

/** One conversation inside a project. */
export interface Conversation {
  id: ConversationId;
  /** The project that owns this conversation; authorization is checked against it. */
  project_id: ProjectId;
  title: string;
  /** ISO 8601 (UTC). */
  created_at: string;
  /**
   * ISO 8601 (UTC), or null when no update time was recorded.
   *
   * @remarks
   * Ordering treats null as `created_at`; do not read it as "never touched".
   */
  updated_at: string | null;
  /** Hidden from default lists but not deleted. */
  archived: boolean;
  /** ISO 8601 (UTC) when soft-deleted; null while the conversation is live. */
  deleted_at: string | null;
}

/** One task in a project. */
export interface Task {
  id: string;
  /** The project that owns this task. */
  project_id: ProjectId;
  title: string;
  status: TaskStatus;
  /** ISO 8601 (UTC). */
  created_at: string;
  /** ISO 8601 (UTC). */
  updated_at: string;
}

/**
 * The closed workflow node vocabulary.
 *
 * @remarks
 * The type decides the payload a node carries: agent and human nodes use `prompt`, a tool node
 * uses `command`.
 */
export const WORKFLOW_NODE_TYPES = ["agent", "tool", "human"] as const;
/** One workflow node type. */
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

/**
 * One node in a workflow graph.
 *
 * @remarks
 * `id` is unique within its graph and is what edges name. A node carries exactly the payload its
 * type uses; the other payload is absent, not empty.
 */
export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  /** Present on agent and human nodes. */
  prompt?: string | undefined;
  /** Present on tool nodes. */
  command?: string | undefined;
}

/** A directed edge between two node ids. */
export interface WorkflowEdge {
  /** Source node id; must exist in the same graph. */
  from: string;
  /** Target node id; must exist in the same graph. */
  to: string;
}

/**
 * The node and edge graph a workflow runs.
 *
 * @remarks
 * A DAG: ids are unique, every edge names an existing node, and no cycle is stored.
 * `validateWorkflowGraph` checks all three; the row schema checks shape only.
 */
export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** A stored workflow. Runs execute a pinned snapshot of its graph. */
export interface Workflow {
  id: string;
  /** The project that owns this workflow. */
  project_id: ProjectId;
  name: string;
  /** Bumped on every edit. A run pins the version it started with. */
  version: number;
  /** The current graph; a run keeps the snapshot it pinned. */
  graph: WorkflowGraph;
  /** ISO 8601 (UTC). */
  created_at: string;
  /** ISO 8601 (UTC). */
  updated_at: string;
}

/**
 * One node of a run, materialized when the run starts.
 *
 * @remarks
 * `node_id` refers to the pinned graph, not the workflow's current graph. Null fields record
 * "not yet happened"; they are never omitted. `status` moves only along the table in
 * `workflow.ts`.
 */
export interface WorkflowRunNode {
  node_id: string;
  status: WorkflowNodeStatus;
  /** The prompt the node ran or is waiting with; null before it starts. */
  prompt: string | null;
  /** The node's result; null until it reaches a terminal state. */
  output: string | null;
  /** The conversation an agent or human node runs in; null for tool nodes or before start. */
  conversation_id: ConversationId | null;
  /** ISO 8601 (UTC); null until the node starts. */
  started_at: string | null;
  /** ISO 8601 (UTC); null until the node reaches a terminal state. */
  finished_at: string | null;
}

/** One execution of a pinned workflow version. */
export interface WorkflowRun {
  id: string;
  /** The workflow this run belongs to; the workflow may have changed since. */
  workflow_id: string;
  /** The workflow version this run pinned; its graph is stored with the run. */
  version: number;
  status: WorkflowRunStatus;
  /** The run's input text. */
  input: string;
  /** JSON text of the node outputs; null until the run finishes. */
  output: string | null;
  /** ISO 8601 (UTC). */
  created_at: string;
  /** ISO 8601 (UTC); null until the run reaches a terminal state. */
  finished_at: string | null;
  /** Absent when runs were loaded without their nodes; an empty array means no nodes. */
  nodes?: WorkflowRunNode[] | undefined;
}

/**
 * The closed automation trigger vocabulary.
 *
 * @remarks
 * The type decides the payload: `schedule` carries a cron expression, `webhook` a token.
 */
export const AUTOMATION_TRIGGER_TYPES = ["schedule", "webhook"] as const;

/**
 * What starts an automation.
 *
 * @remarks
 * A webhook token is the shared secret the caller presents. When a webhook trigger is stored
 * without one, the store generates it, so a stored webhook trigger always carries a token.
 */
export type AutomationTrigger =
  | {
      type: "schedule";
      /** Five-field cron expression, interpreted in `timeZone`. */
      cron: string;
      /** IANA time zone; absent means the server's local time. */
      timeZone?: string | undefined;
    }
  | {
      type: "webhook";
      /** Shared secret the caller presents; generated by the store when absent. */
      token?: string | undefined;
    };

/**
 * The closed automation action vocabulary.
 *
 * @remarks
 * The type decides the payload: `workflow` starts a run, `chat` submits a prompt, `task`
 * creates a task.
 */
export const AUTOMATION_ACTION_TYPES = ["workflow", "chat", "task"] as const;

/**
 * What an automation does when it fires.
 *
 * @remarks
 * `type` selects the payload. Optional fields are defaults for the surface that fires the
 * automation: a task action without `title` uses the automation's name, and a workflow action
 * without `input` uses the webhook body, or empty input when there is none.
 */
export type AutomationAction =
  | { type: "workflow"; workflowId: string; input?: string | undefined }
  | { type: "chat"; conversationId?: ConversationId | undefined; prompt: string }
  | { type: "task"; title?: string | undefined };

/** A stored automation: a trigger and the action it performs in a project. */
export interface Automation {
  id: string;
  /** The project that owns this automation and receives what it creates. */
  project_id: ProjectId;
  name: string;
  trigger: AutomationTrigger;
  action: AutomationAction;
  /** false stops future firings; a firing already running is not aborted. */
  enabled: boolean;
  /**
   * ISO 8601 (UTC) of the last scheduled firing; null before the first one.
   *
   * @remarks
   * The scheduler compares it with the current minute so one automation fires at most once per
   * minute.
   */
  last_fired_at: string | null;
  /** ISO 8601 (UTC). */
  created_at: string;
  /** ISO 8601 (UTC). */
  updated_at: string;
}

/** One attempt to fire an automation, kept for the history view. */
export interface Firing {
  id: string;
  automation_id: string;
  /** ISO 8601 (UTC) when the firing started; `created_at` is when the row was written. */
  at: string;
  status: AutomationFiringStatus;
  /** Free-text outcome or context, such as the trigger origin or a skip reason; null when none. */
  detail: string | null;
  /** The workflow run the action started, when it started one; otherwise null. */
  run_id: string | null;
  /** ISO 8601 (UTC). */
  created_at: string;
}

/**
 * Why a write's outcome is unknown.
 *
 * @remarks
 * `io` means the workspace could not confirm the result, `crash` means it died mid-write, and
 * `timeout` means no answer arrived. In every case the write may have landed; read the file and
 * compare versions before retrying with the same operation id. The machine's answer and the
 * Journal's stored reason are this list, so a schema can be built from it instead of a copy.
 */
export const MUTATION_UNKNOWN_REASONS = [
  "io",
  "crash",
  "timeout",
] as const satisfies readonly string[];

/** Why a write's outcome is unknown (one member of {@link MUTATION_UNKNOWN_REASONS}). */
export type MutationUnknownReason = (typeof MUTATION_UNKNOWN_REASONS)[number];

/**
 * The version value that means "no version": the name is free, or nothing was recorded.
 *
 * @remarks
 * A version is opaque text, so absence cannot be `undefined` on the wire; it is this literal.
 * An expected version, a conflict's current version, and a read's version are all
 * {@link AbsentVersion}, and a caller branches on the text rather than on a missing field.
 */
export const ABSENT_VERSION = "absent";

/** A content version, or {@link ABSENT_VERSION} when there is none. */
export type AbsentVersion = string | typeof ABSENT_VERSION;

/**
 * A versioned write's outcome. The workspace returns it; the editor consumes it.
 *
 * @remarks
 * Expected failures are values, not exceptions: branch on `status`. `applied` carries the new
 * `version`; `conflict` carries the `currentVersion` that won and means nothing was written;
 * `unknown` means the write may have landed, so reconcile before retrying. Every variant echoes
 * the caller's `operationId`, so a retry can be deduplicated.
 */
export type MutationResult =
  | {
      status: "applied";
      /** Echo of the caller's id; identifies this attempt. */
      operationId: string;
      /** The content version written. Opaque: compare it, do not parse it. */
      version: string;
    }
  | {
      status: "conflict";
      operationId: string;
      /** The version found instead of the expected one, or `"absent"`; nothing was written. */
      currentVersion: AbsentVersion;
    }
  | {
      status: "unknown";
      operationId: string;
      /** Why the outcome could not be determined; the write may still have landed. */
      reason: MutationUnknownReason;
    };

/**
 * A versioned read of one file. The workspace returns it; the editor consumes it.
 *
 * @remarks
 * `version` names the exact bytes read: compare it with the version a write expects. It is
 * opaque and changes whenever the content changes.
 */
export interface FileRead {
  /** Normalized path inside the workspace root. */
  path: string;
  /** UTF-8 text. */
  content: string;
  /** Opaque content version, or `"absent"`; compare it, do not parse it. */
  version: AbsentVersion;
}

/**
 * One audit event.
 *
 * @remarks
 * The log never stores bodies, headers, or tokens; `detail` keeps identifiers, statuses, and
 * counts only. Null fields mean the event does not carry that dimension, not that the key is
 * missing.
 */
export interface Event {
  id: string;
  /** ISO 8601 (UTC). */
  at: string;
  level: EventLevel;
  event: EventName;
  /** The request this event belongs to; null when the event is not request-scoped. */
  request_id: string | null;
  /** The conversation this event belongs to; null when not conversation-scoped. */
  conversation_id: ConversationId | null;
  /** HTTP status for `http` and `http.error`; null otherwise. */
  status: number | null;
  /** Elapsed milliseconds, when the event measures work; null otherwise. */
  duration_ms: number | null;
  /** JSON detail; null when there is none. Must not hold secrets. */
  detail: JsonValue | null;
}

/** One event name and how many times it occurred. */
export interface NamedCount {
  event: EventName;
  count: number;
}

/**
 * One run or firing status and how many rows have it.
 *
 * @remarks
 * `status` stays a string because the aggregate covers both workflow runs and automation
 * firings, whose status vocabularies differ.
 */
export interface StatusCount {
  status: string;
  count: number;
}

/**
 * The aggregate store computes from events; the observability view consumes it.
 *
 * @remarks
 * `http`, `chats`, `toolCalls`, `toolErrors`, `agentResponses`, `errors`, and `byEvent`
 * cover the last 24 hours. `workflowRuns` and `firings` count every stored row by status, and
 * `tokensToday` covers the current UTC calendar day. Percentiles are 0 when the window has no
 * samples.
 */
export interface Metrics {
  http: {
    /** Requests in the window. */
    total: number;
    /** Requests in the window grouped by HTTP status. */
    byStatus: Array<{ status: number; count: number }>;
    /** p50 request duration in the window, in milliseconds. */
    p50ms: number;
    /** p95 request duration in the window, in milliseconds. */
    p95ms: number;
  };
  /** Chat events in the window, keyed by event name. */
  chats: Record<string, number>;
  /** All workflow runs grouped by status. */
  workflowRuns: StatusCount[];
  /** All automation firings grouped by status. */
  firings: StatusCount[];
  /** `tool.result` events in the window. */
  toolCalls: number;
  /** `tool.result` events logged at warn in the window. */
  toolErrors: number;
  /** `agent.response` events in the window. */
  agentResponses: number;
  /** Events at error level in the window. */
  errors: number;
  /** Turns, tokens, and cost on the current UTC day. */
  tokensToday: { turns: number; tokens: number; cost: number };
  /** The busiest event names in the window, descending, at most 25. */
  byEvent: NamedCount[];
}

/** Token counts and cost for one model or tool. */
export interface UsageBucket {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Total tokens for the bucket, including cache reads and writes. */
  totalTokens: number;
  /** Cost breakdown; `total` is the bucket's summed cost. */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/**
 * Operational limits applied to a conversation turn.
 *
 * @remarks
 * A value of 0 disables that limit; values are never negative. Limits are enforced where a turn
 * is accepted, not inside the agent.
 */
export interface Limits {
  /** Turns allowed per conversation per minute; 0 means unlimited. */
  turnsPerMinute: number;
  /** Tokens allowed per UTC day; 0 means unlimited. */
  dailyTokenBudget: number;
  /** Abort a turn after this many milliseconds; 0 means no timeout. */
  turnTimeoutMs: number;
}

/**
 * Recorded per turn; the usage view and the limits banner consume it.
 *
 * @remarks
 * `session` is cumulative for the open session, keyed by model id and tool name. `today` covers
 * the current UTC day and is the number the daily budget compares against. `limits` is the
 * configuration in force for this session.
 */
export interface Usage {
  session: { models: Record<string, UsageBucket>; tools: Record<string, UsageBucket> };
  today: { turns: number; tokens: number; cost: number };
  limits: Limits;
}
