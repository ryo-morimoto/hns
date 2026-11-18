import { ConversationIdSchema, ProjectIdSchema, type Conversation } from "@hns/core";
import * as v from "valibot";

/**
 * One line of the conversation as the screen renders it.
 *
 * @remarks
 * The kinds are the screen's own, not pi-durable's: `pi.user`, `pi.assistant`, and
 * `pi.tool-result` are translated at this boundary, so the entry kind never reaches the DOM and
 * the screen has no branch that can print a raw kind. An entry the screen does not know is
 * `system` (shown, unlabelled) rather than dropped: a transcript that silently loses a turn is
 * worse than one that shows it plainly.
 */
export type TranscriptItem =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | { readonly kind: "assistant"; readonly id: string; readonly text: string }
  | {
      readonly kind: "tool";
      readonly id: string;
      /** The tool's name when the entry carried one; the tool id is not a label we invent. */
      readonly name: string;
      readonly text: string;
    }
  | { readonly kind: "system"; readonly id: string; readonly text: string };

/** One entry as the live protocol carries it. */
export interface LiveEntryLike {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
}

/** The assistant entry an interrupted run leaves behind; pi-durable commits it as aborted. */
export const ABORTED_ASSISTANT_KIND = "pi.assistant.aborted";

/** Everything the conversation screen shows, before it is cut into a view. */
export interface ConversationState {
  /** The D1 row, as `/api/conversations/:id/state` answers it. */
  readonly conversation: Conversation;
  /** The entries the socket's snapshot and appends have delivered, oldest first. */
  readonly entries: readonly LiveEntryLike[];
  /** The in-flight answer. */
  readonly draft: string;
  /** The run was stopped, as the view says. */
  readonly interrupted: boolean;
  /** The connection is down; the view is what it was when it went down. */
  readonly connection: "connecting" | "online" | "reconnecting" | "offline";
  /** What this screen made of a stopped run. */
  readonly stop: StopState;
}

/**
 * The stop button and its outcome.
 *
 * @remarks
 * `asked` is the moment between the press and the view that shows the run ended; `stopped` stays
 * until the next turn is sent, so the transcript keeps saying what happened.
 */
export type StopState =
  | { readonly kind: "idle" }
  | { readonly kind: "asked" }
  | { readonly kind: "stopped"; readonly at: string };

/**
 * The screen's kind for one durable entry kind.
 *
 * @remarks
 * The name is the tool's, when the kind carries one; no kind in the protocol today does, so it
 * stays absent and the screen labels the line with the kind alone (`ツール`).
 */
interface ItemKind {
  readonly kind: TranscriptItem["kind"];
  readonly name?: string;
}

/**
 * Translate one durable entry kind to the screen's kind.
 *
 * @param kind - The entry's kind as the live protocol carries it.
 * @returns The item kind, and the tool's name when the kind names one.
 *
 * @remarks
 * An unknown kind becomes `system`: it is shown as text and never as a kind, which is what keeps
 * `pi.*` off the screen even when a newer server adds one this build has not learned.
 */
export function itemKindOf(kind: string): ItemKind {
  switch (kind) {
    case "pi.user":
      return { kind: "user" };
    case "pi.assistant":
    case ABORTED_ASSISTANT_KIND:
      return { kind: "assistant" };
    case "pi.tool-result":
      return { kind: "tool" };
    default:
      return { kind: "system" };
  }
}

/** Sort entries by their decimal id, so a snapshot and an append always agree on order. */
export function sortEntries<T extends LiveEntryLike>(entries: readonly T[]): readonly T[] {
  return [...entries].sort((left, right) => Number(left.id) - Number(right.id));
}

/**
 * Merge the entries a read and the socket both carry, without duplicating either.
 *
 * @param stored - The entries a `/state` read carried.
 * @param live - The entries the socket delivered.
 * @returns One list, oldest first; a live entry replaces the stored one with the same id.
 *
 * @remarks
 * The read and the socket are both behind the same durable log, so the same entry arrives
 * twice. Ids are the identity; merging keeps the socket's copy, because it is the one that was
 * just confirmed against the server rather than read from a response in flight.
 */
export function mergeEntries(
  stored: readonly LiveEntryLike[],
  live: readonly LiveEntryLike[],
): readonly LiveEntryLike[] {
  const byId = new Map<string, LiveEntryLike>();
  for (const entry of stored) byId.set(entry.id, entry);
  for (const entry of live) byId.set(entry.id, entry);
  return sortEntries([...byId.values()]);
}

/**
 * Whether the newest run ended without an answer because it was stopped.
 *
 * @remarks
 * pi-durable commits the partial answer of an aborted run as an aborted assistant entry, and the
 * transcript's newest durable entry is that one. Anything else at the end (a user turn, a tool
 * result, an ordinary answer) means the run is not known to be stopped, so the confirmation is
 * not shown.
 */
export function isInterrupted(entries: readonly LiveEntryLike[]): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    // An empty entry says nothing about how the run ended; look further back.
    if (entry.text === "" && entry.kind === "pi.assistant") continue;
    return entry.kind === ABORTED_ASSISTANT_KIND;
  }
  return false;
}

/** The transcript lines, in order. */
export function transcriptOf(entries: readonly LiveEntryLike[]): readonly TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const entry of sortEntries(entries)) {
    const translated = itemKindOf(entry.kind);
    switch (translated.kind) {
      case "user":
      case "assistant":
      case "system":
        items.push({ kind: translated.kind, id: entry.id, text: entry.text });
        break;
      case "tool":
        items.push({
          kind: "tool",
          id: entry.id,
          name: translated.name ?? "",
          text: entry.text,
        });
        break;
      default: {
        const unhandled: never = translated.kind;
        throw new Error("unhandled transcript kind: " + String(unhandled));
      }
    }
  }
  return items;
}

/** What the progress line says the run is doing. */
type ProgressKind = "thinking" | "tool" | "waiting" | "stopped";

/** The progress line, as the screen renders it. */
export interface ProgressView {
  readonly kind: ProgressKind;
  /** The visible sentence; these are the contract, not a suggestion. */
  readonly label: string;
  /** True while the line should carry the working state (a spinner, a live region). */
  readonly live: boolean;
}

/** The sentence each progress kind shows. */
const PROGRESS_LABELS: Record<ProgressKind, string> = {
  thinking: "考え中",
  tool: "ツール実行中",
  waiting: "待ち",
  stopped: "中断されました",
};

/**
 * What the run is doing, from the transcript and the draft.
 *
 * @param entries - The merged transcript.
 * @param draft - The in-flight answer's text.
 * @param stop - What this screen knows about a stop.
 * @returns The progress line, or null when the conversation is quiet.
 *
 * @remarks
 * The kinds are the three a person needs to tell apart — the model is thinking, a tool is
 * running, or the turn is waiting — plus `stopped`, which is the same line in the same place
 * whatever caused it. The order is: a stop this screen made, then an interrupted view, then the
 * draft (the model is answering), then a trailing tool entry with no answer after it (the tool
 * is running or its result is being read), then a trailing user turn with nothing after it
 * (the turn is waiting to be read).
 */
export function progressOf(
  entries: readonly LiveEntryLike[],
  draft: string,
  stop: StopState,
): ProgressView | null {
  const label = (kind: ProgressKind, live: boolean): ProgressView => ({
    kind,
    label: PROGRESS_LABELS[kind],
    live,
  });
  if (stop.kind === "stopped") return label("stopped", false);
  if (isInterrupted(entries)) return label("stopped", false);
  if (stop.kind === "asked") return label("thinking", true);
  if (draft !== "") return label("thinking", true);
  const last = sortEntries(entries).at(-1);
  if (last === undefined) return null;
  if (last.kind === "pi.tool-result") return label("tool", true);
  if (last.kind === "pi.user") return label("waiting", true);
  return null;
}

/**
 * The state the screen renders.
 *
 * @param input - The conversation, its entries, the draft, the connection, and the stop.
 * @returns The closed screen state; every screen state below is derived from it.
 */
export function conversationStateOf(input: {
  readonly conversation: Conversation;
  readonly entries: readonly LiveEntryLike[];
  readonly draft: string;
  readonly interrupted: boolean;
  readonly connection: ConversationState["connection"];
  readonly stop: StopState;
}): ConversationState {
  return {
    conversation: input.conversation,
    entries: sortEntries(input.entries),
    draft: input.draft,
    interrupted: input.interrupted,
    connection: input.connection,
    stop: input.stop,
  };
}

/** The body of `/api/conversations/:id/state`, as the screen reads it. */
const StateBodySchema = v.object({
  conversation: v.object({
    id: v.string(),
    project_id: v.string(),
    title: v.string(),
    created_at: v.string(),
    updated_at: v.nullable(v.string()),
    archived: v.boolean(),
    deleted_at: v.nullable(v.string()),
  }),
  /** Optional: the object's own members are added opaquely, and this is the one the screen reads. */
  entries: v.optional(v.array(v.object({ id: v.string(), kind: v.string(), text: v.string() }))),
});

/** What a `/state` request produced: the conversation and whatever transcript came with it. */
export type StateRead =
  | {
      readonly ok: true;
      readonly conversation: Conversation;
      readonly entries: readonly LiveEntryLike[];
    }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "unavailable" | "invalid";
      readonly message: string;
    };

/**
 * Read one conversation and its state over the browser's `fetch`.
 *
 * @param conversationId - The conversation the route names.
 * @param fetchImpl - The fetch to use; production passes the global one.
 * @returns The conversation, or a typed refusal.
 *
 * @remarks
 * One round trip: the route is the only read the screen makes, and it is the row plus the
 * object's state rather than a scan of a list (the list is 0121's). `404` is one answer for a
 * conversation that was deleted, one this deployment never had, and one whose Session object no
 * longer holds it; the screen must not tell them apart. A body the schema refuses is
 * `unavailable`, never a half-read conversation.
 */
export async function readConversationState(
  conversationId: string,
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch,
): Promise<StateRead> {
  let response: Response;
  try {
    response = await fetchImpl(
      "/api/conversations/" + encodeURIComponent(conversationId) + "/state",
      { headers: { accept: "application/json" }, credentials: "same-origin" },
    );
  } catch {
    return { ok: false, reason: "unavailable", message: "会話を読み込めませんでした。" };
  }
  if (response.status === 404) {
    return { ok: false, reason: "not_found", message: "この会話は見つかりません。" };
  }
  if (response.status === 400) {
    return { ok: false, reason: "invalid", message: "会話の ID が不正です。" };
  }
  if (!response.ok) {
    return { ok: false, reason: "unavailable", message: "会話を読み込めませんでした。" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "unavailable", message: "会話を読み込めませんでした。" };
  }
  const parsed = v.safeParse(StateBodySchema, body);
  if (!parsed.success) {
    return { ok: false, reason: "unavailable", message: "会話を読み込めませんでした。" };
  }
  const raw = parsed.output.conversation;
  return {
    ok: true,
    conversation: {
      // The schemas add the brands; they are compile-time only (codecs.ts), so a string the row
      // carried is an id once it is an id here.
      id: v.parse(ConversationIdSchema, raw.id),
      project_id: v.parse(ProjectIdSchema, raw.project_id),
      title: raw.title,
      created_at: raw.created_at,
      updated_at: raw.updated_at,
      archived: raw.archived,
      deleted_at: raw.deleted_at,
    },
    entries: parsed.output.entries ?? [],
  };
}
