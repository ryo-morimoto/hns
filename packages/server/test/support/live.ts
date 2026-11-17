import type { AgentLiveView, AgentLiveWatch, AgentSession } from "@hns/agent/session";
import {
  ConversationIdSchema,
  isoTimestamp,
  parseLiveFrame,
  ProjectIdSchema,
  type Conversation,
  type LiveFrame,
} from "@hns/core";
import type { EntryRecord, SessionEnd, Wake } from "@earendil-works/pi-durable";
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
  readonly listeners: ((next: AgentLiveView) => void)[];
  readonly initial: () => AgentLiveView;
  readonly stops: () => number;
  readonly missing: () => boolean;
  setMissing(missing: boolean): void;
  push(next: AgentLiveView): void;
}

/** Build a fake multi-conversation session with one watcher. */
export function fakeSession(initial: AgentLiveView = view()): FakeSession {
  const listeners: ((next: AgentLiveView) => void)[] = [];
  let current = initial;
  let stops = 0;
  let missing = false;

  const session: AgentSession = {
    closed: new Promise<SessionEnd>(() => undefined),
    createConversation: async () => CONVERSATION,
    listConversations: async () => [CONVERSATION],
    getConversation: async (id: string) => {
      if (missing || id !== CONVERSATION.id) return undefined;
      return current.conversation;
    },
    send: async () => {
      throw new Error("not used");
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
    abort: async () => false,
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
