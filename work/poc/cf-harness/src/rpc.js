// Signed RPC from the Durable Object to the machine agent.
const encoder = new TextEncoder();
const keys = new Map();

async function importKey(secret) {
  let key = keys.get(secret);
  if (key === undefined) {
    key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    keys.set(secret, key);
  }
  return key;
}

const toHex = (buffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export function createMetrics() {
  const ops = new Map();
  const rtts = [];
  return {
    record(op, rttMs, bytes) {
      const current = ops.get(op) ?? { count: 0, bytes: 0, totalMs: 0 };
      current.count += 1;
      current.bytes += bytes;
      current.totalMs += rttMs;
      ops.set(op, current);
      rtts.push(rttMs);
      if (rtts.length > 5000) rtts.shift();
    },
    snapshot() {
      const sorted = [...rtts].sort((a, b) => a - b);
      const at = (p) => (sorted.length === 0 ? null : Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 100) / 100);
      return {
        calls: rtts.length,
        rtt: { p50: at(0.5), p95: at(0.95), max: at(1) },
        byOp: Object.fromEntries(
          [...ops].map(([op, value]) => [op, { ...value, totalMs: Math.round(value.totalMs * 100) / 100 }]),
        ),
      };
    },
    reset() {
      ops.clear();
      rtts.length = 0;
    },
  };
}

export function createAgentClient(env, metrics) {
  const baseUrl = env.AGENT_URL;
  const secret = env.HNS_AGENT_SECRET;
  if (typeof baseUrl !== "string" || !baseUrl.startsWith("http")) {
    throw new Error("AGENT_URL is not configured");
  }
  if (typeof secret !== "string" || secret.length < 16) {
    throw new Error("HNS_AGENT_SECRET is not configured");
  }
  return async function call(op, args = {}) {
    const body = JSON.stringify({ op, args });
    const timestamp = Date.now();
    const nonce = crypto.randomUUID();
    const key = await importKey(secret);
    const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${nonce}.${body}`));
    const started = performance.now();
    const response = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hns-timestamp": String(timestamp),
        "x-hns-nonce": nonce,
        "x-hns-signature": toHex(mac),
      },
      body,
    });
    const text = await response.text();
    metrics.record(op, performance.now() - started, text.length);
    if (!response.ok) throw new Error(`${op}: ${response.status} ${text.slice(0, 200)}`);
    const payload = JSON.parse(text);
    if (payload.ok !== true) throw new Error(`${op}: ${payload.code} ${payload.message ?? ""}`);
    return payload;
  };
}
