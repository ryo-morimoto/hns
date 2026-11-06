// Line diff without a file-size cap: trim, anchor on unique lines (patience), LCS inside gaps.
// A gap too large to align is emitted as a wholesale replacement, so nothing is ever refused.

function referenceLcs(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: "same", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: "del", text: a[i] }); i++; }
    else { ops.push({ type: "add", text: b[j] }); j++; }
  }
  while (i < n) ops.push({ type: "del", text: a[i++] });
  while (j < m) ops.push({ type: "add", text: b[j++] });
  return ops;
}

/** Lines that occur exactly once in both sides, in an order that is increasing on both. */
function anchors(a, b) {
  const inA = new Map(), inB = new Map();
  for (let i = 0; i < a.length; i++) inA.set(a[i], inA.has(a[i]) ? -1 : i);
  for (let j = 0; j < b.length; j++) inB.set(b[j], inB.has(b[j]) ? -1 : j);
  const candidates = [];
  for (const [line, i] of inA) {
    if (i < 0) continue;
    const j = inB.get(line);
    if (j !== undefined && j >= 0) candidates.push([i, j]);
  }
  candidates.sort((x, y) => x[0] - y[0]);

  // Longest increasing subsequence of the b indices.
  const tails = [], tailAt = [], previous = new Array(candidates.length).fill(-1);
  for (let k = 0; k < candidates.length; k++) {
    const j = candidates[k][1];
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < j) lo = mid + 1; else hi = mid; }
    if (lo > 0) previous[k] = tailAt[lo - 1];
    tails[lo] = j; tailAt[lo] = k;
  }
  const sequence = [];
  for (let k = tails.length ? tailAt[tails.length - 1] : -1; k >= 0; k = previous[k]) sequence.push(candidates[k]);
  return sequence.reverse();
}

function gap(a, b, ops, maxCells) {
  if (a.length === 0) { for (const text of b) ops.push({ type: "add", text }); return; }
  if (b.length === 0) { for (const text of a) ops.push({ type: "del", text }); return; }
  if (a.length * b.length > maxCells) {
    for (const text of a) ops.push({ type: "del", text });
    for (const text of b) ops.push({ type: "add", text });
    return;
  }
  ops.push(...referenceLcs(a, b));
}

export function diffLines(before, after, { maxCells = 1_000_000 } = {}) {
  const A = before.split("\n");
  const B = after.split("\n");

  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length, endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) { endA--; endB--; }

  const ops = [];
  for (let k = 0; k < start; k++) ops.push({ type: "same", text: A[k] });

  const midA = A.slice(start, endA), midB = B.slice(start, endB);
  let i = 0, j = 0;
  for (const [ai, bi] of anchors(midA, midB)) {
    gap(midA.slice(i, ai), midB.slice(j, bi), ops, maxCells);
    ops.push({ type: "same", text: midA[ai] });
    i = ai + 1; j = bi + 1;
  }
  gap(midA.slice(i), midB.slice(j), ops, maxCells);

  for (let k = endA; k < A.length; k++) ops.push({ type: "same", text: A[k] });

  let added = 0, removed = 0;
  for (const op of ops) { if (op.type === "add") added++; else if (op.type === "del") removed++; }
  return { ops, added, removed };
}

/** Collapse unchanged stretches into skip markers so the UI renders only what changed. */
export function diffHunks(ops, context = 3) {
  const changes = [];
  ops.forEach((op, index) => { if (op.type !== "same") changes.push(index); });
  if (changes.length === 0) return { hunks: [], added: 0, removed: 0 };

  const ranges = [];
  for (const change of changes) {
    const from = Math.max(0, change - context);
    const to = Math.min(ops.length, change + context + 1);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && from <= last.to) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  }

  const hunks = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.from > cursor) hunks.push({ type: "skip", count: range.from - cursor });
    hunks.push({ type: "hunk", ops: ops.slice(range.from, range.to) });
    cursor = range.to;
  }
  if (cursor < ops.length) hunks.push({ type: "skip", count: ops.length - cursor });

  let added = 0, removed = 0;
  for (const op of ops) { if (op.type === "add") added++; else if (op.type === "del") removed++; }
  return { hunks, added, removed };
}
