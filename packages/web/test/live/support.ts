import type { JsonValue, LiveEntry, LiveFrame, LiveSnapshotFrame } from "@hns/core";
import type { LiveSocketFactory, LiveSocketLike } from "../../src/live/client.ts";

/** A socket the client can drive from a test. */
class FakeSocket implements LiveSocketLike {
  readonly url: string;
  readonly sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: string }) => void) | null = null;
  onclose: ((event: { readonly code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }

  /** The server accepted the upgrade. */
  open(): void {
    this.onopen?.();
  }

  /** One JSON text frame from the server. */
  message(frame: LiveFrame | JsonValue): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** The server or network dropped the connection. */
  drop(code = 1006): void {
    this.onclose?.({ code });
  }
}

/** A factory that records every socket it builds, in order. */
export function socketFactory() {
  const sockets: FakeSocket[] = [];
  const factory: LiveSocketFactory = (url: string) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket;
  };
  return { sockets, factory };
}

/** A snapshot frame for tests. */
export function snapshotFrame(
  cursor: string,
  entries: readonly LiveEntry[] = [],
  draft = "",
): LiveSnapshotFrame {
  return {
    type: "snapshot",
    protocol: 1,
    cursor,
    conversationId: "2",
    title: "Live",
    entries,
    draft,
  };
}
