import type { AgentLiveView, AgentLiveWatch, AgentSession } from "@hns/agent/session";
import {
  ConversationIdSchema,
  isoTimestamp,
  parseLiveFrame,
  ProjectIdSchema,
  sendResultOf,
  type Conversation,
  type LiveFrame,
  type LiveSendResult,
} from "@hns/core";
import type {
  ConversationId,
  EntryRecord,
  SessionEnd,
  SettledSubmissionRecord,
  SubmissionId,
  Wake,
} from "@earendil-works/pi-durable";
import type { Turn } from "@hns/agent";
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import * as v from "valibot";
import type { SessionState } from "../../src/do/state.ts";
import type { LiveAttachment, LiveSocket, LiveSocketHost } from "../../src/ws.ts";

/** A conversation the fake session serves. */
export const CONVERSATION: Conversation = {
  id: v.parse(ConversationIdSchema, "2"),
  project_id: v.parse(ProjectIdSchema, "default"),
  title: "Live",
  created_at: isoTimestamp("2026-01-01T00:00:00.000Z"),
  updated_at: null,
  archived: false,
  deleted_at: null,
};

/** Build the smallest entry the live projection reads. */
export function entry(id: number, kind = "pi.assistant", text = ""): EntryRecord {
  const message: UserMessage = { role: "user", content: text, timestamp: 0 };
  const model: readonly Message[] = text === "" ? [] : [message];
  // SAFETY: pi-durable brands ids at compile time only; the fixture id is the number its fake
  // session serves, and the conversation id is the literal the fixture declares.
  return {
    id: id as EntryRecord["id"],
    conversationId: 2 as EntryRecord["conversationId"],
    kind,
    model,
  };
}

/** The view a fake watch publishes. */
export function view(
  entries: readonly EntryRecord[] = [],
  draft = "",
  conversation: Conversation = CONVERSATION,
): AgentLiveView {
  return { conversation, entries, draft };
}

/** A socket that records sends and hibernation attachments. */
export interface FakeSocket extends LiveSocket {
  readonly sent: string[];
  readonly closes: { readonly code: number | undefined; readonly reason: string | undefined }[];
  readonly attachment: () => LiveAttachment | undefined;
}

/** Build a socket with no attachment until one is serialized. */
export function fakeSocket(): FakeSocket {
  const sent: string[] = [];
  const closes: { code: number | undefined; reason: string | undefined }[] = [];
  let attachment: LiveAttachment | undefined;
  return {
    sent,
    closes,
    attachment: () => attachment,
    send(data: string) {
      sent.push(data);
    },
    close(code?: number, reason?: string) {
      closes.push({ code, reason });
    },
    serializeAttachment(value: LiveAttachment) {
      attachment = value;
    },
    deserializeAttachment() {
      return attachment;
    },
  };
}

/** Parse the frames a socket received, through the same parser the client uses. */
export function framesOf(socket: FakeSocket): LiveFrame[] {
  return socket.sent.map((text) => parseLiveFrame(JSON.parse(text)));
}

/**
 * Parse everything a socket received: view frames **and** answers to a send.
 *
 * @remarks
 * A connection writes both kinds to the same socket, so a test that reads only `framesOf`
 * would drop every `accepted` / `rejected`. Each text frame is routed by its `type`, the same
 * way the web client routes one.
 */
export function parseFrames(socket: FakeSocket): readonly (LiveFrame | LiveSendResult)[] {
  return socket.sent.map((text) => {
    const value: unknown = JSON.parse(text);
    // The protocol's own schemas decide: an answer parses as one, anything else as a view frame.
    return sendResultOf(value) ?? parseLiveFrame(value);
  });
}

/** A socket host that records accepts and tags. */
export interface FakeHost extends LiveSocketHost {
  readonly accepted: LiveSocket[];
  readonly tags: readonly string[][];
}

/** Build a host over a list of sockets. */
export function fakeHost(sockets: readonly LiveSocket[] = []): FakeHost {
  const accepted: LiveSocket[] = [];
  const tags: string[][] = [];
  return {
    accepted,
    tags,
    acceptWebSocket(socket: LiveSocket, socketTags: readonly string[] = []) {
      accepted.push(socket);
      tags.push([...socketTags]);
    },
    getWebSockets() {
      return sockets;
    },
  };
}

/** The state-backed host a Session DO uses; the same object survives re-instantiation in tests. */
export interface FakeState extends SessionState {
  readonly sockets: LiveSocket[];
  readonly tags: readonly string[][];
  readonly aborts: string[];
}

/** Build the slice of Durable Object state the Session uses. */
export function fakeState(): FakeState {
  let alarm: number | null = null;
  const sockets: LiveSocket[] = [];
  const tags: string[][] = [];
  const aborts: string[] = [];
  return {
    storage: {
      sql: {
        exec: () => ({
          next: () => ({ done: true as const }),
          toArray: () => [],
        }),
      },
      transaction: <T>(run: () => Promise<T>): Promise<T> => run(),
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => {
        alarm = at;
      },
      deleteAlarm: async () => {
        alarm = null;
      },
    },
    blockConcurrencyWhile: <T>(run: () => Promise<T>): Promise<T> => run(),
    abort: (reason?: string) => {
      aborts.push(reason ?? "");
    },
    acceptWebSocket: (socket: LiveSocket, socketTags: readonly string[] = []) => {
      sockets.push(socket);
      tags.push([...socketTags]);
    },
    getWebSockets: () => sockets,
    sockets,
    tags,
    aborts,
  };
}

/** A fake Session runtime and the controls a test uses to advance it. */
export interface FakeSession {
  readonly session: AgentSession;
  /** Every send the object routed to the runtime, in order: the conversation and its text. */
  readonly sends: readonly {
    readonly id: string;
    readonly text: string;
    readonly requestId: string | undefined;
  }[];
  /** Every abort the object routed to the runtime. */
  readonly aborts: readonly string[];
  readonly listeners: ((next: AgentLiveView) => void)[];
  readonly initial: () => AgentLiveView;
  readonly stops: () => number;
  readonly missing: () => boolean;
  setMissing(missing: boolean): void;
  push(next: AgentLiveView): void;
}

/**
 * The settled submission record one fake turn answers with.
 *
 * @param id - The submission's numeric id.
 * @param conversationId - The conversation the submission belongs to.
 * @param requestId - The deduplication key the route sent, when it sent one.
 * @returns The record pi-durable settles an answered turn with.
 *
 * @remarks
 * The record is the runtime's own shape: a test that reads the settlement id, or the request
 * id a resend is deduplicated by, is reading what production reads.
 */
export function settledSubmission(
  id: number,
  conversationId: string,
  requestId: string | undefined,
): SettledSubmissionRecord {
  // SAFETY: pi-durable brands ids at compile time only; the fake runtime hands out the numbers
  // the test declared, and the record below is read field by field.
  const settled = id as SubmissionId;
  // SAFETY: as above; a conversation id is a decimal id in these fixtures, and the object
  // numbers its conversations the same way.
  const conversation = Number(conversationId) as ConversationId;
  // SAFETY: as above; an entry id is the same pi-durable brand.
  const entry = id as EntryRecord["id"];
  const record = {
    id: settled,
    conversationId: conversation,
    type: "input" as const,
    status: "done" as const,
    entry,
    answer: entry,
  };
  return requestId === undefined ? record : { ...record, requestId };
}

/** Build a fake multi-conversation session with one watcher. */
export function fakeSession(initial: AgentLiveView = view()): FakeSession {
  const listeners: ((next: AgentLiveView) => void)[] = [];
  let current = initial;
  let stops = 0;
  let missing = false;
  const sends: {
    readonly id: string;
    readonly text: string;
    readonly requestId: string | undefined;
  }[] = [];
  const aborts: string[] = [];

  const session: AgentSession = {
    closed: new Promise<SessionEnd>(() => undefined),
    createConversation: async () => CONVERSATION,
    listConversations: async () => [CONVERSATION],
    getConversation: async (id: string) => {
      if (missing || id !== CONVERSATION.id) return undefined;
      return current.conversation;
    },
    send: async (id: string, text: string, requestId?: string) => {
      if (missing || id !== CONVERSATION.id) throw new Error("conversation not found: " + id);
      sends.push({ id, text, requestId });
      const n = sends.length;
      // The settlement is a real settled submission record: the route reads its id, and the
      // shape is pi-durable's, so a change there fails here instead of at the call site.
      return { settlement: settledSubmission(n, id, requestId), text } satisfies Turn;
    },
    transcript: async () => [],
    watchConversation: async (id: string): Promise<AgentLiveWatch> => {
      if (missing || id !== CONVERSATION.id) throw new Error("conversation not found: " + id);
      return {
        initial: current,
        start(listener) {
          listeners.push(listener);
        },
        async stop() {
          stops += 1;
        },
      };
    },
    abort: async (id: string) => {
      if (missing || id !== CONVERSATION.id) return false;
      aborts.push(id);
      return true;
    },
    pendingIndex: async () => ({ entries: [], remaining: 0, legacy: 0 }),
    markIndexed: async () => undefined,
    indexRows: async () => [CONVERSATION],
    wake: (): Wake => ({ active: false }),
    resume: () => undefined,
    close: async () => undefined,
  };

  return {
    session,
    listeners,
    sends,
    aborts,
    initial: () => current,
    stops: () => stops,
    missing: () => missing,
    setMissing(value: boolean) {
      missing = value;
    },
    push(next: AgentLiveView) {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

/**
 * The Node-side stand-in for the 101 response.
 *
 * @remarks
 * Undici's Response constructor refuses status 101; this keeps the client half observable while
 * the cf dev integration proves the real upgrade.
 */
export function testUpgradeResponse(client: LiveSocket): Response {
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, "webSocket", { value: client, enumerable: false });
  return response;
}
