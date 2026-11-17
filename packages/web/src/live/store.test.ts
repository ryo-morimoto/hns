import type { LiveFrame } from "@hns/core";
import { toGlobalId } from "@hns/core/graphql";
import { commitLocalUpdate, type Environment } from "relay-runtime";
import { expect, test } from "vitest";
import { createEnvironment } from "../relay/environment.ts";
import { applyLiveFrameToStore } from "./store.ts";

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

// Catches: a renamed conversation keeping the title the list read returned until the page reloads.
test("a live snapshot writes the conversation title into the store", () => {
  const environment = environmentWithConversation("2", "古い題");
  const frame: LiveFrame = {
    type: "snapshot",
    protocol: 1,
    cursor: "3",
    conversationId: "2",
    title: "新しい題",
    entries: [],
    draft: "",
  };
  applyLiveFrameToStore(environment, frame);
  expect(environment.getStore().getSource().get(toGlobalId("Conversation", "2"))?.["title"]).toBe(
    "新しい題",
  );
});

// Catches: a frame inventing a conversation record before the read that names it has landed.
test("a snapshot for a conversation the store has never seen writes nothing", () => {
  const environment = environmentWithConversation("2", "古い題");
  const frame: LiveFrame = {
    type: "snapshot",
    protocol: 1,
    cursor: "1",
    conversationId: "3",
    title: "まだ一覧に無い会話",
    entries: [],
    draft: "",
  };
  applyLiveFrameToStore(environment, frame);
  expect(environment.getStore().getSource().has(toGlobalId("Conversation", "3"))).toBe(false);
  expect(environment.getStore().getSource().get(toGlobalId("Conversation", "2"))?.["title"]).toBe(
    "古い題",
  );
});

// Catches: a frame type without a title overwriting the stored one with an empty string.
test("frames that carry no title leave the store alone", () => {
  const environment = environmentWithConversation("2", "古い題");
  const frames: readonly LiveFrame[] = [
    { type: "append", protocol: 1, cursor: "4", conversationId: "2", entries: [] },
    { type: "delta", protocol: 1, conversationId: "2", text: "hi", replace: false },
    { type: "pong", protocol: 1 },
    { type: "error", protocol: 1, code: "internal", message: "boom" },
    {
      type: "snapshot",
      protocol: 1,
      cursor: "5",
      conversationId: "2",
      title: "",
      entries: [],
      draft: "",
    },
  ];
  for (const frame of frames) applyLiveFrameToStore(environment, frame);
  expect(environment.getStore().getSource().get(toGlobalId("Conversation", "2"))?.["title"]).toBe(
    "古い題",
  );
});
