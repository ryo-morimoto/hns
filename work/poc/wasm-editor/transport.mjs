// Payload sizes for edit events: JSON vs MessagePack vs CRDT updates.
import * as Y from "yjs";
import { encode } from "@msgpack/msgpack";

const base = Array.from({ length: 4000 }, (_, i) => `export function fn${i}(a, b) { return a + b * ${i}; }`).join("\n");
const baseBytes = Buffer.byteLength(base);
const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v));
const msgBytes = (v) => encode(v).byteLength;

const op = { path: "src/app.ts", expectedVersion: "sha256:" + "a".repeat(64), line: 123, from: 5, to: 6, text: "x" };
const batch = Array.from({ length: 50 }, (_, i) => ({ ...op, line: i }));
const snapshot = { path: "src/app.ts", content: base, expectedVersion: "sha256:" + "a".repeat(64) };

const sizes = {
  op: { json: jsonBytes(op), msgpack: msgBytes(op) },
  batch50: { json: jsonBytes(batch), msgpack: msgBytes(batch) },
  snapshot: { json: jsonBytes(snapshot), msgpack: msgBytes(snapshot) },
  baseBytes,
};

// A CRDT session: 2000 single-character edits, counting the bytes of each update.
const doc = new Y.Doc();
const text = doc.getText("t");
let updateBytes = 0;
doc.on("update", (update) => { updateBytes += update.byteLength; });
text.insert(0, base);

let seed = 12345;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const edits = 2000;
for (let i = 0; i < edits; i++) {
  const at = Math.floor(rand() * text.length);
  if (i % 3 === 0) text.delete(at, 1);
  else text.insert(at, String.fromCharCode(97 + (i % 26)));
}

// A full sync of the first document to a second one.
const peer = new Y.Doc();
Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
const syncBytes = Y.encodeStateAsUpdate(doc).byteLength;

const result = {
  sizes,
  crdt: {
    edits,
    updateBytes,
    perEdit: Math.round(updateBytes / edits),
    fullSyncBytes: syncBytes,
    snapshotPerEditBytes: baseBytes * edits,
  },
  batching: [5, 20, 50].map((rtt) => ({
    rttMs: rtt,
    unbunchedOpsPerSecond: Math.round(1000 / rtt),
    batched10OpsPerSecond: Math.round(1000 / (rtt * (edits / 10) / edits)),
  })),
};
console.log(JSON.stringify(result, null, 2));
