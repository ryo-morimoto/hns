import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai/models";
import { configure, defineDoc, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  EntryRecord,
  HarnessOptions,
  HarnessSettings,
  JsonObject,
  ModelRef,
  Report,
  SessionEnd,
  Storage,
  Tx,
  Wake,
} from "@earendil-works/pi-durable";
import { ConversationIdSchema, isoTimestamp, ProjectIdSchema, type Conversation } from "@hns/core";
import * as v from "valibot";
import type { AgentEventSink } from "./events.ts";
import { lastAssistantText } from "./transcript.ts";
import type { Turn } from "./turn.ts";

/** The maximum conversations a single list returns. */
export const MAX_CONVERSATION_PAGE = 100;
/** The default conversations a single list returns. */
export const DEFAULT_CONVERSATION_PAGE = 50;
/** The maximum transcript entries a single read returns. */
export const MAX_TRANSCRIPT_PAGE = 200;
/** The default transcript entries a single read returns. */
export const DEFAULT_TRANSCRIPT_PAGE = 50;
/** The longest user input accepted by one turn. */
export const MAX_INPUT_LENGTH = 64 * 1024;

/** What to create; projectId is the default project when absent. */
export interface CreateConversationInput {
  readonly title: string;
  readonly projectId?: string | undefined;
}

/** The options the composition root provides to one workspace Session. */
export interface SessionOptions {
  readonly storage: Storage;
  readonly models: Models | (() => Models);
  readonly registry: HarnessOptions["registry"];
  readonly model: ModelRef;
  readonly context: Context;
  readonly settings?: HarnessSettings | undefined;
  readonly env?: HarnessOptions["env"];
  readonly now?: (() => number) | undefined;
  readonly onWake?: ((wake: Wake) => void) | undefined;
  readonly onReport?: ((report: Report) => void) | undefined;
  readonly onEvent?: AgentEventSink | undefined;
  readonly newRequestId?: (() => string) | undefined;
}

/** One workspace's live, multi-conversation Session. */
export interface AgentSession {
  /** Settles when the Harness closes; `failed` means the host must reopen from storage. */
  readonly closed: Promise<SessionEnd>;
  /** Create a conversation and its metadata in one commit. */
  createConversation(input: CreateConversationInput): Promise<Conversation>;
  /** Newest conversations first, at most {@link MAX_CONVERSATION_PAGE}. */
  listConversations(limit?: number): Promise<readonly Conversation[]>;
  /** One conversation, or undefined when absent. */
  getConversation(id: string): Promise<Conversation | undefined>;
  /** Admit one user turn and wait for its settlement. */
  send(id: string, text: string, requestId?: string): Promise<Turn>;
  /** Newest transcript entries first. */
  transcript(id: string, limit?: number): Promise<readonly EntryRecord[]>;
  /** Abort the conversation's ordinary run; false when the conversation is absent. */
  abort(id: string): Promise<boolean>;
  /** What the next host wakeup is for, if anything. */
  wake(): Wake;
  /** Enable scheduling; idempotent. */
  resume(): void;
  /** Close the Harness and its storage. */
  close(): Promise<void>;
}

/** A conversation id that is not a decimal pi-durable id. */
export class InvalidConversationIdError extends Error {
  constructor(value: string) {
    super("invalid conversation id: " + value);
    this.name = "InvalidConversationIdError";
  }
}

/** A valid conversation id with no live conversation. */
export class ConversationNotFoundError extends Error {
  constructor(value: string) {
    super("conversation not found: " + value);
    this.name = "ConversationNotFoundError";
  }
}

interface ConversationMetadata extends JsonObject {
  readonly title: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly isArchived: boolean;
  readonly deletedAt: string | null;
}

interface ConversationIndex extends JsonObject {
  readonly items: Record<string, ConversationMetadata>;
}

/**
 * The product metadata that pi-durable's conversation record does not carry.
 *
 * @remarks
 * A session-scoped document keeps the create and the metadata in one commit and makes the
 * list one read. A missing entry for an existing conversation is corruption, not an empty
 * title, so the reader throws instead of inventing one.
 */
const ConversationIndexDoc = defineDoc<ConversationIndex>({
  kind: "hns.conversation.index",
  version: 1,
  scope: "session",
  initial: () => ({ items: {} }),
  checkpointWhen: () => false,
});

const CreateInputSchema: v.GenericSchema<unknown, CreateConversationInput> = v.object({
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  projectId: v.optional(v.pipe(v.string(), v.minLength(1)), "default"),
});

const InputSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_INPUT_LENGTH));

/**
 * Parse a decimal pi-durable conversation id.
 *
 * @internal
 * @throws InvalidConversationIdError when the value is not a positive safe integer.
 */
function conversationId(value: string): ConversationId {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new InvalidConversationIdError(value);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new InvalidConversationIdError(value);
  // SAFETY: pi-durable's ConversationId is a branded number allocated as a positive safe integer;
  // the decimal check and the range check above are the evidence.
  return parsed as ConversationId;
}

/**
 * Clamp a page size to a positive integer no larger than the cap.
 *
 * @internal
 */
function cap(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.trunc(value), maximum);
}

/**
 * Build the public Conversation from the durable record and its metadata.
 *
 * @internal
 * @throws ValiError when a stored field is not a valid id or timestamp.
 */
function toConversation(id: ConversationId, meta: ConversationMetadata): Conversation {
  return {
    id: v.parse(ConversationIdSchema, String(id)),
    project_id: v.parse(ProjectIdSchema, meta.projectId),
    title: meta.title,
    created_at: isoTimestamp(meta.createdAt),
    updated_at: isoTimestamp(meta.updatedAt),
    archived: meta.isArchived,
    deleted_at: meta.deletedAt === null ? null : isoTimestamp(meta.deletedAt),
  };
}

/**
 * Read the metadata index; an absent document means no conversation was created yet.
 *
 * @internal
 */
async function readIndex(harness: Harness, context: Context): Promise<Readonly<ConversationIndex>> {
  const snapshot = await harness.snapshot(ConversationIndexDoc, context);
  return snapshot ?? { items: {} };
}

/**
 * Write one conversation's metadata in the caller's transaction.
 *
 * @internal
 */
async function writeMetadata(
  tx: Tx,
  id: ConversationId,
  metadata: ConversationMetadata,
): Promise<void> {
  const doc = await tx.doc(ConversationIndexDoc);
  doc.items[String(id)] = metadata;
}

/**
 * Update one conversation's timestamp in its own commit.
 *
 * @internal
 * @throws Error when the metadata index has no entry for the conversation.
 */
async function touchMetadata(
  harness: Harness,
  id: ConversationId,
  nowIso: () => string,
  context: Context,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ConversationIndexDoc);
    const meta = doc.items[String(id)];
    if (meta === undefined) {
      throw new Error("conversation metadata is missing: " + String(id));
    }
    meta.updatedAt = nowIso();
  }, context);
}

/**
 * Open one workspace's multi-conversation Session.
 *
 * @param options - Storage, models, registry, model, and the host callbacks.
 * @returns The open session; the caller owns it and must close it.
 * @throws Whatever Harness.open throws; a failed open leaves no usable session.
 *
 * @remarks
 * No `setTimer` is passed: durable wakeups come from `onWake` and the host's Durable Object
 * alarm. pi-durable declines background timers in Workers; foreground timers only pace work
 * and never schedule a wakeup across hibernation.
 */
export async function openSession(options: SessionOptions): Promise<AgentSession> {
  const clock = options.now ?? Date.now;
  const nowIso = (): string => isoTimestamp(new Date(clock()).toISOString());
  const harness = await Harness.open(
    options.storage,
    {
      models: options.models,
      registry: options.registry,
      settings: () => options.settings,
      env: options.env ?? (() => undefined),
      now: clock,
      onWake: options.onWake ?? (() => undefined),
      onReport: options.onReport ?? (() => undefined),
      conversationCreated: async (tx, conversation) => {
        await configure(tx, conversation.id, { model: options.model });
      },
    },
    options.context,
  );

  /** Read one metadata entry, failing loudly when the index is incomplete. */
  const metadataOf = async (id: ConversationId): Promise<ConversationMetadata> => {
    const index = await readIndex(harness, options.context);
    const meta = index.items[String(id)];
    if (meta === undefined) {
      throw new Error("conversation metadata is missing: " + String(id));
    }
    return meta;
  };

  return {
    closed: harness.closed,
    async createConversation(input: CreateConversationInput): Promise<Conversation> {
      const parsed = v.parse(CreateInputSchema, input);
      const createdAt = nowIso();
      const metadata: ConversationMetadata = {
        title: parsed.title,
        projectId: parsed.projectId ?? "default",
        createdAt,
        updatedAt: createdAt,
        isArchived: false,
        deletedAt: null,
      };
      const conversation = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          init: async (tx, id) => {
            await writeMetadata(tx, id, metadata);
          },
        },
        options.context,
      );
      return toConversation(conversation.id, metadata);
    },
    async listConversations(limit?: number): Promise<readonly Conversation[]> {
      const page = await options.storage.scanConversations(
        { order: "descending" },
        cap(limit, DEFAULT_CONVERSATION_PAGE, MAX_CONVERSATION_PAGE),
        undefined,
        options.context,
      );
      const index = await readIndex(harness, options.context);
      const out: Conversation[] = [];
      for (const record of page.items) {
        if (record.id === ROOT_CONVERSATION_ID) continue;
        const meta = index.items[String(record.id)];
        if (meta === undefined) {
          throw new Error("conversation metadata is missing: " + String(record.id));
        }
        out.push(toConversation(record.id, meta));
      }
      return out;
    },
    async getConversation(id: string): Promise<Conversation | undefined> {
      const conversation = await options.storage.conversation(conversationId(id), options.context);
      if (conversation === undefined) return undefined;
      return toConversation(conversation.id, await metadataOf(conversation.id));
    },
    async send(id: string, text: string, requestId?: string): Promise<Turn> {
      const parsedText = v.parse(InputSchema, text);
      const conversation = await harness.conversation(conversationId(id), options.context);
      if (conversation === undefined) throw new ConversationNotFoundError(id);
      const request = requestId ?? (options.newRequestId ?? (() => crypto.randomUUID()))();
      const submission = await conversation.submit(
        { type: "input", content: parsedText, requestId: request },
        options.context,
      );
      const settlement = await submission.wait(options.context);
      const answer = await lastAssistantText(conversation, options.context);
      await touchMetadata(harness, conversation.id, nowIso, options.context);
      options.onEvent?.({
        event: "agent.response",
        at: new Date(clock()).toISOString(),
        text: answer,
      });
      return { settlement, text: answer };
    },
    async transcript(id: string, limit?: number): Promise<readonly EntryRecord[]> {
      const conversation = await harness.conversation(conversationId(id), options.context);
      if (conversation === undefined) throw new ConversationNotFoundError(id);
      const page = await conversation.entries(
        { order: "descending" },
        cap(limit, DEFAULT_TRANSCRIPT_PAGE, MAX_TRANSCRIPT_PAGE),
        undefined,
        options.context,
      );
      return page.items;
    },
    async abort(id: string): Promise<boolean> {
      const conversation = await harness.conversation(conversationId(id), options.context);
      if (conversation === undefined) return false;
      await conversation.abort(options.context);
      await touchMetadata(harness, conversation.id, nowIso, options.context);
      return true;
    },
    wake(): Wake {
      return harness.wake();
    },
    resume(): void {
      harness.resume();
    },
    async close(): Promise<void> {
      await harness.close(options.context);
    },
  };
}
