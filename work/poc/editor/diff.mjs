// Line diff: trim the common ends, then LCS on what is left. Bounded.
export function diffLines(before, after, { maxCells = 1_000_000, maxLines = 5_000 } = {}) {
  const A = before.split("\n");
  const B = after.split("\n");
  if (A.length > maxLines || B.length > maxLines) return { tooLarge: true, ops: [] };

  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length, endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) { endA--; endB--; }

  const midA = A.slice(start, endA);
  const midB = B.slice(start, endB);
  if (midA.length * midB.length > maxCells) return { tooLarge: true, ops: [] };

  const n = midA.length, m = midB.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  for (let k = 0; k < start; k++) ops.push({ type: "same", text: A[k] });
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) { ops.push({ type: "same", text: midA[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: "del", text: midA[i] }); i++; removed++; }
    else { ops.push({ type: "add", text: midB[j] }); j++; added++; }
  }
  while (i < n) { ops.push({ type: "del", text: midA[i++] }); removed++; }
  while (j < m) { ops.push({ type: "add", text: midB[j++] }); added++; }
  for (let k = endA; k < A.length; k++) ops.push({ type: "same", text: A[k] });

  return { tooLarge: false, ops, added, removed };
}
