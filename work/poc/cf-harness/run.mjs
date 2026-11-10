// Measurement driver: submits turns and reports wall time plus the DO's RPC metrics.
const BASE = process.env.POC_URL ?? "http://127.0.0.1:8787";
const TURNS = Number(process.env.TURNS ?? 5);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getJson = async (path, init) => {
  const response = await fetch(`${BASE}${path}`, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
};

const runTurn = async (text) => {
  const started = performance.now();
  await getJson("/api/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  await sleep(30);
  for (;;) {
    const state = await getJson("/api/state");
    if (state.active !== true) return { ms: Math.round(performance.now() - started), state };
    if (performance.now() - started > 120_000) throw new Error("turn timed out");
    await sleep(10);
  }
};

await getJson("/api/reset", { method: "POST" });
const turns = [];
for (let index = 0; index < TURNS; index += 1) {
  const result = await runTurn(`measure ${index}`);
  turns.push(result.ms);
  console.log(JSON.stringify({ turn: index, ms: result.ms }));
}
const metrics = await getJson("/api/metrics");
const sorted = [...turns].sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      turns: turns.length,
      turnMs: {
        p50: sorted[Math.floor(sorted.length / 2)],
        min: sorted[0],
        max: sorted[sorted.length - 1],
      },
      env: metrics,
    },
    null,
    2,
  ),
);
