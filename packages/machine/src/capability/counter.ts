import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { deny } from "@hns/core/capability";
import type { DenyDecision } from "@hns/core/capability";

/**
 * The machine's spend of one grant: how many calls and how many bytes it has used, kept on the
 * machine's disk (0225, `docs/capability.md` §5).
 *
 * @remarks
 * A grant is a **budget**, and the budget is the machine's to keep: the Worker issues
 * `maxCalls` / `maxBytes` once per session × tool × manifest × machine, and the machine spends it
 * locally, so a per-call round trip to the Session DO disappears. The state therefore survives a
 * restart: a grant that has spent its last call cannot become usable again by restarting the
 * agent, and counting starts from the file, not from zero.
 *
 * **Where it lives.** `<configDir>/grants/<grantId>.json`, where `configDir` is `~/.config/hns` by
 * default. That directory is hidden from the agent's shell by the machine's fixed sandbox hide
 * list (0194), so a tool call the agent makes cannot read — or rewrite — the counters it is held
 * to. The machine process itself runs outside the sandbox, which is why it can.
 *
 * **What an unreadable state means.** Every refusal here is a **denial, not an exception**, and a
 * state that cannot be read, parsed, or written is *closed*: a machine that cannot prove it has
 * budget left refuses the call (`counter_exhausted` for a spend, `unsupported` for a state file
 * that is not this contract's shape). Deleting the file does not grant a fresh budget either:
 * the grant's own `maxCalls` / `maxBytes` are the only limits, and a missing file reads as "no
 * spend yet" — which is why the file is `0600` in a directory the agent cannot reach, and why a
 * spend is written before the tool runs.
 *
 * **Two callers, one file.** The machine handles requests concurrently, and two operations of the
 * same grant may spend at the same moment. Inside one process an in-process lock serializes the
 * read-modify-write of one `grantId`; across processes the write is a `rename` of a fully written
 * temp file, which is atomic on a POSIX filesystem. Two *processes* spending the same grant at the
 * same instant could still both read the same remaining budget; the machine runs one agent process
 * per ROOT (the Worker talks to one `origin`), so the lock that matters is the in-process one. A
 * second process is refused by the machine's single-listener design, not by this file.
 */

/** The spend of one grant, as the state file records it. */
export interface GrantSpend {
  /** The state file's format version; a file without it is not this contract's spend. */
  readonly v: 1;
  readonly grantId: string;
  /** Calls spent so far; a call is spent before it runs, never after. */
  readonly calls: number;
  /** Bytes of output spent so far. */
  readonly bytes: number;
  /** When this grant's spend was first recorded (ISO 8601), for pruning. */
  readonly openedAt: string;
  /** When it was last spent (ISO 8601). */
  readonly updatedAt: string;
}

const SpendSchema: v.GenericSchema<unknown, GrantSpend> = v.strictObject({
  v: v.literal(1),
  grantId: v.pipe(v.string(), v.minLength(1)),
  calls: v.pipe(v.number(), v.integer(), v.minValue(0)),
  bytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
  openedAt: v.pipe(v.string(), v.minLength(1)),
  updatedAt: v.pipe(v.string(), v.minLength(1)),
});

/**
 * A grant id, as this module spells it in a file name.
 *
 * @remarks
 * The issuer makes the id a UUID, but the id arrives inside a grant the machine only *verifies*,
 * so it is checked here before it becomes a path: a `../` or a `/` in it would let a grant choose
 * which file is written. The set is deliberately narrow — a UUID, and nothing a shell or a path
 * resolver reads specially.
 */
const GRANT_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/u;

/** Whether `grantId` may name a file in the state directory. */
export function isStateGrantId(grantId: string): boolean {
  return GRANT_ID_PATTERN.test(grantId);
}

/** The mode of the state directory and every file in it: the operator's alone. */
const STATE_MODE = 0o600;
const STATE_DIRECTORY_MODE = 0o700;

/** One consume request. */
export interface ConsumeInput {
  /** The grant's id (`payload.grantId`); the spend is kept per grant. */
  readonly grantId: string;
  /** The grant's bounds, as verified. `calls` is spent once per consume. */
  readonly maxCalls: number;
  /** The grant's byte bound; `bytes` is the size of the output this call may return. */
  readonly maxBytes: number;
  /** Bytes this call may return, counted against `maxBytes` when the call is allowed. */
  readonly bytes: number;
  /** The machine's clock, epoch milliseconds. */
  readonly now: number;
}

/** What one consume decided. */
export type ConsumeResult =
  | { readonly outcome: "allow"; readonly spend: GrantSpend }
  | { readonly outcome: "deny"; readonly decision: DenyDecision };

/** Why a state file could not be read as this contract's spend. */
type StateRead =
  | { readonly kind: "missing" }
  | { readonly kind: "spend"; readonly spend: GrantSpend }
  | { readonly kind: "corrupt"; readonly reason: string };

/**
 * The machine's per-grant counters, in one directory.
 *
 * @remarks
 * Construct one per machine agent: the in-process lock is per instance, so two instances over the
 * same directory are two lock domains. `configDir` is the directory the counters live in, not the
 * operator's whole `~/.config/hns`: a caller may point it at a temporary directory in a test.
 */
export class GrantCounter {
  readonly #directory: string;
  /** The chain of one grant's spend, so two consumes of it never read the same remainder. */
  readonly #locks = new Map<string, Promise<unknown>>();
  /** The bound check a spend runs; the product's, unless a probe replaces it. */
  readonly #withinBudget: (spend: GrantSpend | undefined, input: ConsumeInput) => boolean;

  /**
   * @param directory - The directory the state lives in (`<configDir>/grants`).
   * @param options - `withinBudget` replaces the check a spend makes against the grant's bounds. A
   * test passes one to observe what the bound is worth (`test/security/`); a deployment never does.
   */
  constructor(
    directory: string,
    options: { readonly withinBudget?: GrantCounterBudget | undefined } = {},
  ) {
    this.#directory = directory;
    this.#withinBudget = options.withinBudget ?? withinBudget;
  }

  /** The directory the counters live in. */
  get directory(): string {
    return this.#directory;
  }

  /**
   * Spend one call of a grant, atomically.
   *
   * @param input - The grant's id and bounds, the bytes this call may return, and the clock.
   * @returns `allow` with the spend after the call, or a `deny` that names why: the call would pass
   * `maxCalls` or `maxBytes` (`counter_exhausted`), the state cannot be read or written
   * (`counter_exhausted` when it is a spend that cannot be recorded, `unsupported` when the file is
   * not this contract's shape).
   *
   * @remarks
   * The order is the contract's: a state file that is not this contract's shape is refused before
   * anything is spent, so a corrupt file never becomes a fresh budget; a spend that would exceed
   * either bound is refused **without** writing, so a refused call leaves the remainder where it
   * was; an allowed call writes `calls + 1` and `bytes + input.bytes` before its caller runs the
   * tool, which is what makes the bound hold when the tool crashes.
   */
  async consume(input: ConsumeInput): Promise<ConsumeResult> {
    return await this.#serialized(input.grantId, async () => await this.#spend(input));
  }

  /**
   * The spend recorded for a grant, without spending anything.
   *
   * @param grantId - The grant's id.
   * @returns The spend, or `undefined` when the grant has none (or the file is unreadable: a reader
   * that only reports never needs to tell "missing" from "corrupt", and the caller that *spends*
   * does).
   */
  async read(grantId: string): Promise<GrantSpend | undefined> {
    const state = await this.#read(grantId);
    return state.kind === "spend" ? state.spend : undefined;
  }

  /** Serialize the work of one grant behind any work already running for it. */
  async #serialized<T>(grantId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(grantId) ?? Promise.resolve();
    const run = previous.then(work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(grantId, tail);
    try {
      return await run;
    } finally {
      if (this.#locks.get(grantId) === tail) this.#locks.delete(grantId);
    }
  }

  async #spend(input: ConsumeInput): Promise<ConsumeResult> {
    if (!isStateGrantId(input.grantId)) {
      return this.#refuse("grant_invalid", "the grant id is not one this machine can record");
    }
    const state = await this.#read(input.grantId);
    if (state.kind === "corrupt") {
      return this.#refuse("unsupported", "the grant's spend cannot be read: " + state.reason);
    }
    const spend = state.kind === "spend" ? state.spend : undefined;
    const calls = spend?.calls ?? 0;
    const bytes = spend?.bytes ?? 0;
    if (!this.#withinBudget(spend, input)) {
      return this.#refuse("counter_exhausted", "the grant has spent its budget");
    }
    const at = new Date(input.now).toISOString();
    const next: GrantSpend = {
      v: 1,
      grantId: input.grantId,
      calls: calls + 1,
      bytes: bytes + input.bytes,
      openedAt: spend?.openedAt ?? at,
      updatedAt: at,
    };
    try {
      await this.#write(next);
    } catch {
      // A spend that cannot be recorded is a spend that did not happen: the call may not run.
      return this.#refuse("counter_exhausted", "the grant's spend cannot be recorded");
    }
    return { outcome: "allow", spend: next };
  }

  #refuse(code: DenyDecision["code"], message: string): ConsumeResult {
    return { outcome: "deny", decision: deny(code, message) };
  }

  /** `<directory>/<grantId>.json`. */
  #path(grantId: string): string {
    return join(this.#directory, grantId + ".json");
  }

  async #read(grantId: string): Promise<StateRead> {
    if (!isStateGrantId(grantId))
      return { kind: "corrupt", reason: "the grant id is not a file id" };
    let text: string;
    try {
      text = await readFile(this.#path(grantId), "utf8");
    } catch (thrown) {
      // Only a missing file is "no spend yet". A permission error, a directory, or a device that
      // fails the read is the state being unreadable, which is not a fresh budget.
      if (isMissing(thrown instanceof Error ? thrown : new Error("the read failed"))) {
        return { kind: "missing" };
      }
      return { kind: "corrupt", reason: "the state file cannot be read" };
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { kind: "corrupt", reason: "the state file is not JSON" };
    }
    const parsed = v.safeParse(SpendSchema, value);
    if (!parsed.success) return { kind: "corrupt", reason: "the state file is not a spend" };
    if (parsed.output.grantId !== grantId) {
      return { kind: "corrupt", reason: "the state file names another grant" };
    }
    return { kind: "spend", spend: parsed.output };
  }

  /**
   * Write one spend, atomically: a temp file in the same directory, then a `rename`.
   *
   * @remarks
   * The temp file is written and synced before the rename, so a reader never sees half a JSON
   * document: a crash leaves either the old spend or the new one. The directory is created
   * `0700`; on an existing directory the mode is not re-applied (a machine does not own its home
   * directory's permissions), and the file itself is created `0600`.
   */
  async #write(spend: GrantSpend): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: STATE_DIRECTORY_MODE });
    const target = this.#path(spend.grantId);
    const temporary = target + "." + String(process.pid) + "." + crypto.randomUUID() + ".tmp";
    await writeFileAtomically(temporary, target, JSON.stringify(spend));
  }
}

/**
 * Whether a spend still fits the grant's bounds.
 *
 * @param spend - The spend so far, or `undefined` for a grant that has not spent anything.
 * @param input - The spend about to happen.
 * @returns `false` when one more call would pass `maxCalls`, or when adding this call's output would
 * pass `maxBytes`. The two are one predicate because they are one refusal (`counter_exhausted`) and
 * one budget: a caller that changed one without the other would already have changed the contract.
 */
export type GrantCounterBudget = (spend: GrantSpend | undefined, input: ConsumeInput) => boolean;

/** The product's bound check: both bounds, at the boundary. */
function withinBudget(spend: GrantSpend | undefined, input: ConsumeInput): boolean {
  const calls = spend?.calls ?? 0;
  const bytes = spend?.bytes ?? 0;
  return calls < input.maxCalls && bytes + input.bytes <= input.maxBytes;
}

/** What a failed node:fs call says: the only member this module reads. */
const FsErrorSchema = v.object({ code: v.string() });

/**
 * Whether a read failure says "no such file" rather than "cannot read".
 *
 * @param error - Whatever `readFile` threw: a value this module did not produce, parsed before any
 * member of it is read.
 */
function isMissing(error: Error): boolean {
  const parsed = v.safeParse(FsErrorSchema, error);
  return parsed.success && parsed.output.code === "ENOENT";
}

/**
 * Write `json` to `target` through `temporary`, both in the same directory.
 *
 * @remarks
 * `0o600` at creation, then the rename. The temp file is removed on failure so a failed write
 * leaves no half state behind.
 */
async function writeFileAtomically(temporary: string, target: string, json: string): Promise<void> {
  const handle = await open(temporary, "wx", STATE_MODE);
  try {
    await handle.writeFile(json, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  // The directory entry is synced too, so a crash after the rename cannot resurrect the old spend.
  const directory = await open(dirname(target), constants.O_RDONLY);
  try {
    await directory.sync();
  } catch {
    // A filesystem that denies fsync on a directory still has the atomic rename; the spend stands.
  } finally {
    await directory.close();
  }
}
