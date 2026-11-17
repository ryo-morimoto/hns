import type { LiveFrame } from "@hns/core";
import { toGlobalId } from "@hns/core/graphql";
import { commitLocalUpdate, type Environment } from "relay-runtime";
import * as v from "valibot";
import { expect, test } from "vitest";
import { createEnvironment } from "../relay/environment.ts";
import { applyLiveFrameToStore, forgetLiveTitle, reapplyLiveTitles } from "./store.ts";

/** An environment holding one conversation record, as a list read would leave it. */
function environmentWithConversation(id: string, title: string): Environment {
  const environment = createEnvironment({
    fetch: () => Promise.reject(new Error("the store test never reads the network")),
  });
  commitLocalUpdate(environment, (store) => {
    const record = store.create(toGlobalId("Conversation", id), "Conversation");
    record.setValue(title, "title");
  });
  return environment;
}

/** A snapshot frame for a conversation. */
function snapshotOf(conversationId: string, title: string): LiveFrame {
  return {
    type: "snapshot",
    protocol: 1,
    cursor: "3",
    conversationId,
    title,
    entries: [],
    draft: "",
  };
}

/** Write a title straight into the store, as a list read's normalization does. */
function overwriteTitle(environment: Environment, id: string, title: string): void {
  commitLocalUpdate(environment, (store) => {
    store.get(toGlobalId("Conversation", id))?.setValue(title, "title");
  });
}

/** The title the store holds for a conversation. */
function storedTitle(environment: Environment, id: string): string | undefined {
  const record = environment.getStore().getSource().get(toGlobalId("Conversation", id));
  const parsed = v.safeParse(v.string(), record?.["title"]);
  return parsed.success ? parsed.output : undefined;
}

// Catches: a renamed conversation keeping the title the list read returned until the page reloads.
test("a live snapshot writes the conversation title into the store", () => {
  const environment = environmentWithConversation("2", "古い題");
  applyLiveFrameToStore(environment, snapshotOf("2", "新しい題"));
  expect(storedTitle(environment, "2")).toBe("新しい題");
});

// Catches: a list read normalizing the server's older title over the one the socket reported,
// so the open conversation's title flips back after a reconnect refetch.
test("a list read that overwrote the live title is corrected", () => {
  const environment = environmentWithConversation("2", "古い題");
  applyLiveFrameToStore(environment, snapshotOf("2", "ライブの題"));
  overwriteTitle(environment, "2", "Web の土台");
  reapplyLiveTitles(environment);
  expect(storedTitle(environment, "2")).toBe("ライブの題");
});

// Catches: a closed conversation keeping its last snapshot title and winning over every later
// read, including a rename made from another client.
test("a closed conversation stops holding its live title", () => {
  const environment = environmentWithConversation("2", "古い題");
  applyLiveFrameToStore(environment, snapshotOf("2", "ライブの題"));
  forgetLiveTitle(environment, "2");
  overwriteTitle(environment, "2", "サーバーの題");
  reapplyLiveTitles(environment);
  expect(storedTitle(environment, "2")).toBe("サーバーの題");
});

// Catches: a rename to an empty title being dropped, so the store keeps the previous one.
test("an empty snapshot title is written like any other", () => {
  const environment = environmentWithConversation("2", "古い題");
  applyLiveFrameToStore(environment, snapshotOf("2", ""));
  expect(storedTitle(environment, "2")).toBe("");
});

// Catches: a frame inventing a conversation record before the read that names it has landed.
test("a snapshot for a conversation the store has never seen writes nothing", () => {
  const environment = environmentWithConversation("2", "古い題");
  applyLiveFrameToStore(environment, snapshotOf("3", "まだ一覧に無い会話"));
  expect(environment.getStore().getSource().has(toGlobalId("Conversation", "3"))).toBe(false);
  expect(storedTitle(environment, "2")).toBe("古い題");
});

// Catches: a frame type without a title overwriting the stored one.
test("frames that carry no title leave the store alone", () => {
  const environment = environmentWithConversation("2", "古い題");
  const frames: readonly LiveFrame[] = [
    { type: "append", protocol: 1, cursor: "4", conversationId: "2", entries: [] },
    { type: "delta", protocol: 1, conversationId: "2", text: "hi", replace: false },
    { type: "pong", protocol: 1 },
    { type: "error", protocol: 1, code: "internal", message: "boom" },
  ];
  for (const frame of frames) applyLiveFrameToStore(environment, frame);
  expect(storedTitle(environment, "2")).toBe("古い題");
});
