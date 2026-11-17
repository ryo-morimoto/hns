import type { IsoTimestamp, ReviewFailure, ReviewTreeEntry } from "@hns/core";
import { ReviewSourceError } from "./source.ts";
import type { ReviewSource } from "./source.ts";

/**
 * The review diff: what changed between two checkpoint commits, as a reviewer reads it.
 *
 * @remarks
 * A review compares two commits the caller names, not a range of history: a checkpoint commit has
 * no parents, so `base` and `head` are independent roots. The files are the union of the two trees,
 * each one added, deleted, or modified; a file whose bytes are the same on both sides is not in the
 * list at all. `added` and `removed` are the line counts over every hunk.
 */
export interface ReviewDiff {
  /** The base commit as the source read it. */
  readonly base: ReviewCommitView;
  /** The head commit as the source read it. */
  readonly head: ReviewCommitView;
  /** One entry per changed path, in path order. */
  readonly files: readonly ReviewFileDiff[];
  /** Lines added over every hunk. */
  readonly added: number;
  /** Lines removed over every hunk. */
  readonly removed: number;
}

/** The part of a commit a diff names. */
export interface ReviewCommitView {
  readonly commit: string;
  readonly tree: string;
  readonly message: string;
  readonly committedAt: IsoTimestamp;
}

/**
 * How a path changed.
 *
 * @remarks
 * `symlink` is separate from `added`/`deleted`/`modified` only by `entryKind`: a link is still a file
 * whose bytes are its target, so it diffs like any other file and the kind tells the viewer not to
 * render it as content.
 */
export type ReviewChangeKind = "added" | "deleted" | "modified";

/** What a path is on the head side, or on the base side for a deleted path. */
export type ReviewEntryKind = "blob" | "symlink" | "tree" | "commit";

/** One changed file. */
export interface ReviewFileDiff {
  readonly path: string;
  readonly kind: ReviewChangeKind;
  /** The entry kind on the head (or the base, for a deleted path). */
  readonly entryKind: ReviewEntryKind;
  /** The blob id on the base side, absent for an added path. */
  readonly baseObject?: string | undefined;
  /** The blob id on the head side, absent for a deleted path. */
  readonly headObject?: string | undefined;
  /** The hunks, or none for a binary file (the change still appears). */
  readonly hunks: readonly ReviewHunk[];
  /** Lines added in this file. */
  readonly added: number;
  /** Lines removed in this file. */
  readonly removed: number;
}

/** One hunk: a run of changed lines with context, and where it starts on each side. */
export interface ReviewHunk {
  /** The 1-based line the hunk starts at on the base side; 0 when the base side is empty. */
  readonly baseStart: number;
  /** The 1-based line the hunk starts at on the head side; 0 when the head side is empty. */
  readonly headStart: number;
  /** The hunk's lines, unchanged and changed, in order. */
  readonly lines: readonly ReviewDiffLine[];
}

/** One line of a hunk. */
export interface ReviewDiffLine {
  readonly kind: "context" | "add" | "del";
  readonly text: string;
}

/**
 * The result of a diff: the diff, or the expected failure that stopped it.
 *
 * @remarks
 * A failure is a value, not a throw: a source that cannot read a side makes the whole diff
 * unavailable, because a partial diff would look complete. Which path failed is in `message`, so a
 * caller can say it; a defect (an exception that is not {@link ReviewSourceError}) still throws.
 */
export type ReviewDiffResult =
  | { readonly ok: true; readonly diff: ReviewDiff }
  | { readonly ok: false; readonly failure: ReviewFailure; readonly message: string };

/** The default context lines around a change. */
const CONTEXT = 3;

/** A line diff in an array form, so a hunk can be cut by index. */
interface LineOp {
  readonly type: "same" | "add" | "del";
  readonly text: string;
}
/**
 * The line diff of two texts: unchanged stretches trimmed, equal lines anchored (patience), and the
 * gaps between anchors aligned by longest common subsequence, with a cell bound so a large gap is a
 * wholesale replacement instead of an expensive alignment.
 *
 * @remarks
 * This is the algorithm the editor already uses (0009 / 0011), kept in step with it: a gap whose
 * `before × after` exceeds `maxCells` is emitted as every deletion then every addition, so nothing is
 * ever refused and the result is still a valid diff.
 */
const diffLines = (
  before: readonly string[],
  after: readonly string[],
  maxCells = 1_000_000,
): LineOp[] => {
  const ops: LineOp[] = [];
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start])
    start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  for (let index = 0; index < start; index += 1)
    ops.push({ type: "same", text: before[index] ?? "" });

  const middleBefore = before.slice(start, endBefore);
  const middleAfter = after.slice(start, endAfter);
  let left = 0;
  let right = 0;
  for (const [anchorBefore, anchorAfter] of anchors(middleBefore, middleAfter)) {
    gap(
      middleBefore.slice(left, anchorBefore),
      middleAfter.slice(right, anchorAfter),
      ops,
      maxCells,
    );
    ops.push({ type: "same", text: middleBefore[anchorBefore] ?? "" });
    left = anchorBefore + 1;
    right = anchorAfter + 1;
  }
  gap(middleBefore.slice(left), middleAfter.slice(right), ops, maxCells);
  for (let index = endBefore; index < before.length; index += 1) {
    ops.push({ type: "same", text: before[index] ?? "" });
  }
  return ops;
};

/** Lines that occur exactly once on each side, in an order increasing on both. */
const anchors = (
  before: readonly string[],
  after: readonly string[],
): readonly (readonly [number, number])[] => {
  const inBefore = new Map<string, number>();
  const inAfter = new Map<string, number>();
  before.forEach((line, index) => {
    inBefore.set(line, inBefore.has(line) ? -1 : index);
  });
  after.forEach((line, index) => {
    inAfter.set(line, inAfter.has(line) ? -1 : index);
  });
  const candidates: [number, number][] = [];
  for (const [line, indexBefore] of inBefore) {
    if (indexBefore < 0) continue;
    const indexAfter = inAfter.get(line);
    if (indexAfter !== undefined && indexAfter >= 0) candidates.push([indexBefore, indexAfter]);
  }
  candidates.sort((left, right) => left[0] - right[0]);
  // The longest increasing subsequence of the after-indices is the anchor set.
  const tails: number[] = [];
  const tailAt: number[] = [];
  const previous = candidates.map(() => -1);
  candidates.forEach(([, right], index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((tails[middle] ?? 0) < right) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tailAt[low - 1] ?? -1;
    tails[low] = right;
    tailAt[low] = index;
  });
  const sequence: [number, number][] = [];
  for (
    let index = tails.length > 0 ? (tailAt[tails.length - 1] ?? -1) : -1;
    index >= 0;
    index = previous[index] ?? -1
  ) {
    const candidate = candidates[index];
    if (candidate !== undefined) sequence.push(candidate);
  }
  return sequence.reverse();
};

/** Add the alignment of one gap between anchors. */
const gap = (
  before: readonly string[],
  after: readonly string[],
  ops: LineOp[],
  maxCells: number,
): void => {
  if (before.length === 0) {
    for (const text of after) ops.push({ type: "add", text });
    return;
  }
  if (after.length === 0) {
    for (const text of before) ops.push({ type: "del", text });
    return;
  }
  if (before.length * after.length > maxCells) {
    for (const text of before) ops.push({ type: "del", text });
    for (const text of after) ops.push({ type: "add", text });
    return;
  }
  for (const op of lcs(before, after)) ops.push(op);
};

/** The longest common subsequence of two small slices, as ops. */
const lcs = (before: readonly string[], after: readonly string[]): LineOp[] => {
  const rows = before.length + 1;
  const columns = after.length + 1;
  const table = new Uint32Array(rows * columns);
  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      const here = row * columns + column;
      const down = (row + 1) * columns + column;
      const right = row * columns + column + 1;
      table[here] =
        before[row] === after[column]
          ? (table[(row + 1) * columns + column + 1] ?? 0) + 1
          : Math.max(table[down] ?? 0, table[right] ?? 0);
    }
  }
  const ops: LineOp[] = [];
  let row = 0;
  let column = 0;
  while (row < before.length && column < after.length) {
    if (before[row] === after[column]) {
      ops.push({ type: "same", text: before[row] ?? "" });
      row += 1;
      column += 1;
    } else if (
      (table[(row + 1) * columns + column] ?? 0) >= (table[row * columns + column + 1] ?? 0)
    ) {
      ops.push({ type: "del", text: before[row] ?? "" });
      row += 1;
    } else {
      ops.push({ type: "add", text: after[column] ?? "" });
      column += 1;
    }
  }
  while (row < before.length) {
    ops.push({ type: "del", text: before[row] ?? "" });
    row += 1;
  }
  while (column < after.length) {
    ops.push({ type: "add", text: after[column] ?? "" });
    column += 1;
  }
  return ops;
};

/**
 * Cut a line diff into hunks: each change with {@link CONTEXT} unchanged lines either side.
 *
 * @param ops - The line diff.
 * @returns The hunks with their starting lines on each side.
 *
 * @remarks
 * A change with no line at all (a file that was empty) still gets a hunk: the empty file changed.
 */
const hunksOf = (ops: readonly LineOp[]): readonly ReviewHunk[] => {
  const changes: number[] = [];
  ops.forEach((op, index) => {
    if (op.type !== "same") changes.push(index);
  });
  if (changes.length === 0) return [];
  const ranges: { from: number; to: number }[] = [];
  for (const change of changes) {
    const from = Math.max(0, change - CONTEXT);
    const to = Math.min(ops.length, change + CONTEXT + 1);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && from <= last.to) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  }
  // Each hunk's start line needs the number of lines before it on each side.
  const beforeStart = new Map<number, number>();
  const afterStart = new Map<number, number>();
  let beforeLine = 1;
  let afterLine = 1;
  ops.forEach((op, index) => {
    beforeStart.set(index, beforeLine);
    afterStart.set(index, afterLine);
    if (op.type !== "add") beforeLine += 1;
    if (op.type !== "del") afterLine += 1;
  });
  return ranges.map((range) => ({
    baseStart: beforeStart.get(range.from) ?? 0,
    headStart: afterStart.get(range.from) ?? 0,
    lines: ops
      .slice(range.from, range.to)
      .map((op) => ({ kind: lineKind(op.type), text: op.text })),
  }));
};

/** The op type as a diff line kind: `same` is context. */
const lineKind = (type: LineOp["type"]): ReviewDiffLine["kind"] =>
  type === "same" ? "context" : type;

/** A text split into lines, keeping no line terminator; a trailing newline does not add a line. */
const linesOf = (bytes: Uint8Array): readonly string[] => {
  const text = new TextDecoder().decode(bytes);
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
};

/** Whether bytes look like text: no NUL and valid UTF-8. */
const isText = (bytes: Uint8Array): boolean => {
  if (bytes.includes(0x00)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

/** A path and its entry kind, as one side of the diff lists it. */
interface SideEntry {
  readonly path: string;
  readonly entry: ReviewTreeEntry;
}

/**
 * Walk every file below `path` on one side, one directory at a time.
 *
 * @remarks
 * A review lists files, not directories: a directory that exists on both sides with no changed file
 * is not a change. A submodule (`commit`) is listed by its id but never read, so a path that is a
 * submodule on one side and a file on the other still appears.
 */
const collect = async (
  source: ReviewSource,
  commit: string,
  path: string,
): Promise<readonly SideEntry[]> => {
  const entries = await source.readTree(commit, path);
  const found: SideEntry[] = [];
  for (const entry of entries) {
    const full = path === "" ? entry.path : path + "/" + entry.path;
    if (entry.kind === "tree") {
      for (const below of await collect(source, commit, full)) found.push(below);
    } else {
      found.push({ path: full, entry });
    }
  }
  return found;
};

/** Read one side of a changed file, or nothing when that side has no file there. */
const readSide = async (
  source: ReviewSource,
  commit: string,
  entry: ReviewTreeEntry | undefined,
  path: string,
): Promise<Uint8Array> => {
  if (entry === undefined || entry.kind === "commit") return new Uint8Array(0);
  return (await source.readFile(commit, path)).bytes;
};

/**
 * Diff two checkpoint commits through a {@link ReviewSource}.
 *
 * @param source - Where the commits are read from; the function uses only `log`, `readTree`, and
 * `readFile`, so it never reaches a machine, a ref, or a binding of its own.
 * @param base - The base commit id.
 * @param head - The head commit id.
 * @returns The diff, or the expected failure that stopped it.
 * @throws When the source throws something that is not a {@link ReviewSourceError}: that is a defect,
 * not a review failure.
 *
 * @remarks
 * The walk reads both trees and every changed file before it returns, and any expected failure of
 * the source makes the whole answer `ok: false` with the failing path in `message`. A partial diff
 * would look complete to a viewer, which is exactly the failure a review must not make.
 */
export const reviewDiff = async (
  source: ReviewSource,
  base: string,
  head: string,
): Promise<ReviewDiffResult> => {
  try {
    return { ok: true, diff: await diffOrThrow(source, base, head) };
  } catch (cause) {
    if (cause instanceof ReviewSourceError) {
      return { ok: false, failure: cause.code, message: cause.message };
    }
    throw cause;
  }
};

/** The diff work itself, with a source failure thrown for {@link reviewDiff} to catch. */
const diffOrThrow = async (
  source: ReviewSource,
  base: string,
  head: string,
): Promise<ReviewDiff> => {
  const baseCommit = await source.log(base);
  const headCommit = await source.log(head);
  const before = new Map<string, ReviewTreeEntry>();
  for (const found of await collect(source, base, "")) before.set(found.path, found.entry);
  const after = new Map<string, ReviewTreeEntry>();
  for (const found of await collect(source, head, "")) after.set(found.path, found.entry);

  const paths = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const files: ReviewFileDiff[] = [];
  let added = 0;
  let removed = 0;
  for (const path of paths) {
    const baseEntry = before.get(path);
    const headEntry = after.get(path);
    const unchanged =
      baseEntry !== undefined && headEntry !== undefined && baseEntry.object === headEntry.object;
    if (unchanged) continue;
    const kind: ReviewChangeKind =
      baseEntry === undefined ? "added" : headEntry === undefined ? "deleted" : "modified";
    const baseBytes = await readSide(source, base, baseEntry, path);
    const headBytes = await readSide(source, head, headEntry, path);
    // A binary file is still a change; it just has no hunks to show.
    const hunks =
      isText(baseBytes) && isText(headBytes)
        ? hunksOf(diffLines(linesOf(baseBytes), linesOf(headBytes)))
        : [];
    const fileAdded = hunks.reduce(
      (total, hunk) => total + hunk.lines.filter((line) => line.kind === "add").length,
      0,
    );
    const fileRemoved = hunks.reduce(
      (total, hunk) => total + hunk.lines.filter((line) => line.kind === "del").length,
      0,
    );
    added += fileAdded;
    removed += fileRemoved;
    files.push({
      path,
      kind,
      entryKind: entryKindOf(headEntry ?? baseEntry),
      baseObject: baseEntry?.object,
      headObject: headEntry?.object,
      hunks,
      added: fileAdded,
      removed: fileRemoved,
    });
  }
  return {
    base: {
      commit: baseCommit.commit,
      tree: baseCommit.tree,
      message: baseCommit.message,
      committedAt: baseCommit.committedAt,
    },
    head: {
      commit: headCommit.commit,
      tree: headCommit.tree,
      message: headCommit.message,
      committedAt: headCommit.committedAt,
    },
    files,
    added,
    removed,
  };
};

/**
 * The kind of a side's entry, from its git mode.
 *
 * @remarks
 * The mode is the tree's own statement: `120000` is a symlink, `160000` a submodule, `40000` a
 * directory, and any other file mode a regular file. A missing side (the other side has no entry
 * there) is a file, which is what an added or deleted path is.
 */
const entryKindOf = (entry: ReviewTreeEntry | undefined): ReviewEntryKind => {
  switch (entry?.mode) {
    case "120000":
      return "symlink";
    case "160000":
      return "commit";
    case "40000":
      return "tree";
    case undefined:
    case "100644":
    case "100755":
      return "blob";
  }
};
