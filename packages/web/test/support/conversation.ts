/* oxlint-disable anti-slop/no-runtime-typeof -- the platform's fetch input is a Request,
   a URL, or a URL string; these stubs read which one they were given. */
import { ConversationIdSchema, ProjectIdSchema, type Conversation } from "@hns/core";
import * as v from "valibot";

/** The fields a test may change on the fixture row. */
type RowOverrides = Partial<{
  id: string;
  project_id: string;
  title: string;
  created_at: string;
  updated_at: string | null;
  archived: boolean;
  deleted_at: string | null;
}>;

/** The response's own `conversation` object, as the route spells it: the DTO field for field. */
interface ConversationDto {
  readonly id: string;
  readonly project_id: string;
  readonly title: string;
  readonly created_at: string;
  readonly updated_at: string | null;
  readonly archived: boolean;
  readonly deleted_at: string | null;
}

/** The route's answer: the DTO under `conversation`, plus whatever the object added. */
export interface ConversationStateBody {
  readonly ok: true;
  readonly conversation: ConversationDto;
}

/** The conversation DTO for one fixture row. */
function conversationDto(overrides: RowOverrides = {}): ConversationDto {
  const row = conversationRow(overrides);
  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived: row.archived,
    deleted_at: row.deleted_at,
  };
}

/** The row `/api/conversations/:id/state` carries under `conversation`. */
function conversationRow(overrides: RowOverrides = {}): Conversation {
  return {
    id: v.parse(ConversationIdSchema, overrides.id ?? "conversation-intent"),
    project_id: v.parse(ProjectIdSchema, overrides.project_id ?? "project-hns"),
    title: overrides.title ?? "Web の土台",
    created_at: overrides.created_at ?? "2026-11-07T00:00:00.000Z",
    updated_at:
      overrides.updated_at === undefined ? "2026-11-07T00:10:00.000Z" : overrides.updated_at,
    archived: overrides.archived ?? false,
    deleted_at: overrides.deleted_at ?? null,
  };
}

/**
 * One conversation-state answer, as the route sends it.
 *
 * @remarks
 * The body is the core DTO under `conversation` plus whatever the Session object answered
 * beside it. The fixture keeps both, so a test asserts on the body the production reader
 * actually parses.
 */
export function conversationStateBody(overrides: RowOverrides = {}): ConversationStateBody {
  return { ok: true, conversation: conversationDto(overrides) };
}

/** One intercepted request: its URL and its method. */
interface FetchedRequest {
  readonly url: string;
  readonly method: string;
}

/** A JSON answer: a status (200 when absent) and a body the test chose. */
interface JsonReply {
  readonly status?: number;
  readonly body: unknown;
}

/**
 * What the app's `fetch` answers with while it is stubbed.
 *
 * @remarks
 * `pending` is the loading state without a timer: a request that names no reply is held until
 * the test calls `release`, which answers all of them at once. `network` is a failed connection.
 */
export type StubbedFetch =
  | { readonly kind: "reply"; readonly reply: JsonReply }
  | { readonly kind: "network" }
  | { readonly kind: "pending" };

/** The stub and the handles a test uses on it. */
export interface FetchStub {
  /** Every request the app made, in order. */
  readonly requests: FetchedRequest[];
  /** Answer the requests held by a `pending` stub. */
  release(reply: JsonReply): void;
  /** Put the original fetch back. */
  restore(): void;
}

/** The URL of a request the app made. */
function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.href;
  if (typeof input === "string") return input;
  return input.url;
}

/**
 * Replace `globalThis.fetch` with a stub that records every request.
 *
 * @param next - What each request is answered with, looked up per request so a test can change
 * its mind between reads.
 * @returns The requests and the handles above.
 *
 * @remarks
 * Only the app's own HTTP goes through this; Relay in the shell tests uses its environment's
 * injected fetch and is untouched. Restoring is the caller's job (an `afterEach`).
 */
export function interceptFetch(next: () => StubbedFetch): FetchStub {
  const original = globalThis.fetch;
  const requests: FetchedRequest[] = [];
  let holding: ((response: Response) => void)[] = [];
  const respond = (reply: JsonReply): Response =>
    new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: requestUrl(input), method: init?.method ?? "GET" });
    const given = next();
    switch (given.kind) {
      case "reply":
        return respond(given.reply);
      case "network":
        throw new TypeError("network");
      case "pending":
        return new Promise<Response>((resolve) => {
          holding.push(resolve);
        });
      default: {
        const unhandled: never = given;
        throw new Error("unhandled stub: " + JSON.stringify(unhandled));
      }
    }
  };
  return {
    requests,
    release(reply: JsonReply) {
      const all = holding;
      holding = [];
      for (const resolve of all) resolve(respond(reply));
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}
