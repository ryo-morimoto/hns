import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as v from "valibot";

/** The repository root; the cf CLI and the ignored test projects hang off it. */
const REPO_ROOT = resolve(import.meta.dirname, "../..");

/** Where the integration suites write their cf projects; ignored by git. */
export const CF_DEV_WORK_DIR = join(REPO_ROOT, "tools", "deploy", ".work");

const CF = join(REPO_ROOT, "node_modules", ".bin", "cf");

/** wrangler fixes the debug inspector here for every cf dev, so only one may run at a time. */
const INSPECTOR_PORT = 9_229;

/** The directory this user's lock lives in; the temp directory itself is shared by every user. */
const LOCK_DIR = join(tmpdir(), "hns-cf-dev-" + String(process.getuid?.() ?? "shared"));
const LOCK_PATH = join(LOCK_DIR, "inspector.lock");
/** The short-lived guard that makes a takeover exclusive. */
const TAKEOVER_PATH = LOCK_PATH + ".takeover";

/** A record whose owner is gone, or that is this old, was abandoned by a worker that died. */
const LOCK_STALE_MS = 10 * 60_000;
/** A half-written record is replaced within milliseconds; it is only abandoned this long after. */
const TORN_STALE_MS = 5_000;
/** A guard section is three file operations; one left this long belongs to a dead worker. */
const TAKEOVER_STALE_MS = 5_000;
/**
 * How long a start queues for the lock.
 *
 * @remarks
 * A test that starts cf dev twice spends at most two of these plus four ready windows, which is
 * what the restart suites' 300s timeout budgets for.
 */
const LOCK_TIMEOUT_MS = 60_000;
const LOCK_POLL_MS = 250;
const DEFAULT_MODE = "development";
const DEFAULT_READY_TIMEOUT_MS = 60_000;
/** How long a start waits for the previous cf dev to release the inspector before spawning. */
const INSPECTOR_WAIT_MS = 10_000;
const HEALTH_POLL_MS = 100;
const HEALTH_TIMEOUT_MS = 2_000;
const KILL_TIMEOUT_MS = 5_000;
const KILL_POLLS = 50;
// Below the kernel's ephemeral range (32768 and up), so a probe cannot race an unrelated listener.
const PORT_BASE = 18_100;
const PORT_SPAN = 900;
const PORT_ATTEMPTS = 20;
/** Only this user reads the record, and only the owner is meant to write it. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Whether the cf CLI is installed, so a suite can skip instead of failing where it is not. */
/**
 * A requirement the release gate makes mandatory.
 *
 * @remarks
 * Locally, a missing `cf` or `bubblewrap` skips the suites that need it, which is convenient on a
 * machine without the tools. In CI that skip is a hole: the job is green while the integration
 * tier did not run. When the matching environment variable is set (`HNS_REQUIRE_CF`,
 * `HNS_REQUIRE_BWRAP`), a missing tool is a failure instead of a skip.
 */
export const requireTool = (name: "cf" | "bwrap", installed: boolean, why: string): boolean => {
  const required = process.env[name === "cf" ? "HNS_REQUIRE_CF" : "HNS_REQUIRE_BWRAP"] === "1";
  if (installed) return true;
  if (required) throw new Error(name + " is required here but unavailable: " + why);
  return false;
};

/** Whether `cf` (cloudflare dev) is installed; throws when the release gate requires it. */
export const isCfDevInstalled = (): boolean =>
  requireTool("cf", existsSync(CF), "cf not found at " + CF);

/**
 * Whether bubblewrap is available; throws when the release gate requires it.
 *
 * @param available - The sandbox probe's verdict (`detectSandbox`).
 * @param why - The probe's reason, for the failure message.
 * @returns The same verdict, so a suite can write `if (!requireBwrap(status.available, status.reason)) skip`.
 */
export const requireBwrap = (available: boolean, why: string): boolean =>
  requireTool("bwrap", available, why);

/** How to start one cf dev. */
export interface CfDevOptions {
  /** The cf project: its `cloudflare.config.ts`, entrypoint, and node_modules link. */
  cwd: string;
  /** How long the child has to answer `/health` before the start counts as failed. */
  readyTimeoutMs?: number | undefined;
}

/** One running cf dev. */
export interface CfDev {
  /** `http://127.0.0.1:<port>`; the project answers `/health` on it. */
  readonly url: string;
  readonly port: number;
  /** Everything the child wrote so far, for a failure message. */
  output(): string;
  /** Kill the process group and release the lock; calling it twice is safe. */
  stop(): Promise<void>;
}

interface Running {
  readonly child: ChildProcess;
  readonly output: () => string;
}

interface Started {
  readonly running: Running;
  readonly port: number;
}

type Attempt =
  | { readonly ok: true; readonly started: Started }
  | { readonly ok: false; readonly output: string };

const lockRecord = v.object({
  /** The process that took the lock: the worker that started the child. */
  pid: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** When it was taken, so a record can also be judged on its age alone. */
  at: v.pipe(v.string(), v.isoTimestamp()),
  /** Identifies one acquisition, so a late release cannot delete a later owner's file. */
  token: v.pipe(v.string(), v.minLength(1)),
  /** The cf dev child, once it exists, so an abandoned start can be cleaned up. */
  child: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

/** One lock record. */
export type LockRecord = v.InferOutput<typeof lockRecord>;

/** What the lock file says, with the age the decision needs. */
export type LockSnapshot =
  | { readonly state: "absent" }
  | { readonly state: "held"; readonly record: LockRecord; readonly ageMs: number }
  | { readonly state: "unreadable"; readonly ageMs: number };

/** What a start may do with a snapshot. */
export type LockJudgement = "free" | "held" | "abandoned";

interface InspectorLock {
  /** Record the child, so a lock abandoned by a dead worker can free the inspector port. */
  own(childPid: number): Promise<void>;
  release(): Promise<void>;
}

type Takeover =
  | { readonly taken: false }
  | { readonly taken: true; readonly orphan: LockRecord | undefined };

/** The lock this process holds, so a second start fails instead of waiting on itself. */
let held: string | undefined;

/** The lock directory, created once with the owner's mode before any record is written. */
let lockDirectory: Promise<void> | undefined;

/**
 * Read one lock record.
 *
 * @remarks
 * The record is external input: a torn write, an older shape, or another user's file parses to
 * `null` and the caller decides from the age alone.
 */
export const parseLock = (text: string): LockRecord | null => {
  try {
    const parsed = v.safeParse(lockRecord, JSON.parse(text));
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
};

/**
 * What a start may do with a lock snapshot.
 *
 * @remarks
 * "free" is an absent record. A readable record is "held" while its owner lives and it is younger
 * than {@link LOCK_STALE_MS}. A torn record is "held" for the few milliseconds a writer needs and
 * "abandoned" after {@link TORN_STALE_MS}. Everything else is "abandoned": the owner died or the
 * record outlived every suite. The judgement is a snapshot, so a takeover re-reads under the guard.
 */
export const judgeLock = (snapshot: LockSnapshot, ownerAlive: boolean): LockJudgement => {
  switch (snapshot.state) {
    case "absent":
      return "free";
    case "unreadable":
      return snapshot.ageMs >= TORN_STALE_MS ? "abandoned" : "held";
    case "held":
      return snapshot.ageMs >= LOCK_STALE_MS || !ownerAlive ? "abandoned" : "held";
  }
};

/**
 * Whether a snapshot still describes the record a takeover judged abandoned.
 *
 * @remarks
 * The guard makes the read and the replacement exclusive, but the record was judged before it was
 * taken: another waiter may have replaced it, or its owner may have released and a new holder
 * created. Only the record that was judged may be replaced, so a fresh record is never deleted —
 * that window is what let two waiters hold the lock at once.
 */
export const sameRecord = (judged: LockSnapshot, current: LockSnapshot): boolean => {
  switch (judged.state) {
    case "absent":
      return current.state === "absent";
    case "unreadable":
      return current.state === "unreadable" && current.ageMs >= TORN_STALE_MS;
    case "held":
      return current.state === "held" && current.record.token === judged.record.token;
  }
};

/** The POSIX code a failed file call carried, when it carried one. */
const errnoOf = (thrown: Error): string => {
  const parsed = v.safeParse(v.object({ code: v.string() }), thrown);
  return parsed.success ? parsed.output.code : "";
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A live process owned by another user answers EPERM, not ESRCH.
    return error instanceof Error && errnoOf(error) === "EPERM";
  }
};

const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited, so there is nothing left to signal.
      return;
    }
  }
};

const ensureLockDirectory = async (): Promise<void> => {
  lockDirectory ??= mkdir(LOCK_DIR, { recursive: true, mode: DIR_MODE }).then(() => undefined);
  await lockDirectory;
};

const ageOf = async (path: string): Promise<number> => {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch {
    // The file went away under the read; the caller sees it as free.
    return 0;
  }
};

const remove = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (errnoOf(error) !== "ENOENT") throw error;
  }
};

const readLock = async (): Promise<LockSnapshot> => {
  let text: string;
  try {
    text = await readFile(LOCK_PATH, "utf8");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (errnoOf(error) === "ENOENT") return { state: "absent" };
    throw error;
  }
  const record = parseLock(text);
  if (record === null) return { state: "unreadable", ageMs: await ageOf(LOCK_PATH) };
  return { state: "held", record, ageMs: await ageOf(LOCK_PATH) };
};

const createLock = async (token: string, at: string): Promise<boolean> => {
  await ensureLockDirectory();
  try {
    await writeFile(LOCK_PATH, JSON.stringify({ pid: process.pid, at, token }), {
      flag: "wx",
      mode: FILE_MODE,
    });
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (errnoOf(error) !== "EEXIST") throw error;
    return false;
  }
};

/**
 * Replace the record in one rename.
 *
 * @remarks
 * The path never goes absent, so a waiter cannot create a second record between a delete and a
 * create; readers see either the old record or the new one.
 */
const writeLock = async (token: string, at: string, child?: number): Promise<void> => {
  await ensureLockDirectory();
  const temporary = LOCK_PATH + "." + token + ".tmp";
  const record: LockRecord =
    child === undefined ? { pid: process.pid, at, token } : { pid: process.pid, at, token, child };
  try {
    await writeFile(temporary, JSON.stringify(record), { flag: "wx", mode: FILE_MODE });
    await rename(temporary, LOCK_PATH);
  } catch (error) {
    await remove(temporary);
    throw error;
  }
};

const releaseLock = async (token: string): Promise<void> => {
  if (held !== token) return;
  held = undefined;
  const current = await readLock();
  if (current.state !== "held" || current.record.token !== token) return;
  await remove(LOCK_PATH);
};

/** Take the guard that makes read-then-replace exclusive, or report that another waiter has it. */
const takeGuard = async (): Promise<boolean> => {
  await ensureLockDirectory();
  try {
    await writeFile(TAKEOVER_PATH, String(process.pid), { flag: "wx", mode: FILE_MODE });
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (errnoOf(error) !== "EEXIST") throw error;
  }
  if ((await ageOf(TAKEOVER_PATH)) < TAKEOVER_STALE_MS) return false;
  console.log("[cf dev] taking over the guard an abandoned takeover left behind");
  await remove(TAKEOVER_PATH);
  return false;
};

/**
 * Replace the record a start judged abandoned, exclusively.
 *
 * @remarks
 * The record is re-read inside the guard and only replaced when {@link sameRecord} still holds, so a
 * record another waiter already replaced is never touched. The new record exists before the orphan
 * is killed, so a process this start signals is the one the replaced record named.
 */
const takeOver = async (token: string, at: string, judged: LockSnapshot): Promise<Takeover> => {
  if (!(await takeGuard())) return { taken: false };
  try {
    const current = await readLock();
    if (!sameRecord(judged, current)) return { taken: false };
    await writeLock(token, at);
    return { taken: true, orphan: judged.state === "held" ? judged.record : undefined };
  } finally {
    await remove(TAKEOVER_PATH);
  }
};

/**
 * Whether that pid is still a cf dev.
 *
 * @remarks
 * A stale record names a pid that may since have been reused, so the command line is checked
 * before anything is signalled; without procfs nothing is signalled at all.
 */
const isCfDevProcess = async (pid: number): Promise<boolean> => {
  let command: string;
  try {
    command = await readFile("/proc/" + String(pid) + "/cmdline", "utf8");
  } catch {
    return false;
  }
  const parts = command.split("\0");
  return parts.includes("dev") && parts.some((part) => part === "cf" || part.endsWith("/cf"));
};

/** Kill what a dead worker left behind, unless the pid no longer belongs to a cf dev. */
const killAbandoned = async (record: LockRecord): Promise<void> => {
  const child = record.child;
  if (child === undefined) return;
  if (!(await isCfDevProcess(child))) {
    console.log("[cf dev] the lock names pid " + String(child) + ", which is no longer a cf dev");
    return;
  }
  console.log("[cf dev] killing pid " + String(child) + ", a cf dev left behind by a dead worker");
  signalGroup(child, "SIGKILL");
  // The inspector is only free once the group is gone; a start that races the exit would lose it.
  for (let attempt = 0; attempt < KILL_POLLS && pidAlive(child); attempt += 1) {
    await sleep(HEALTH_POLL_MS);
  }
};

const describeHolder = (snapshot: LockSnapshot): string =>
  snapshot.state === "held"
    ? "pid " + String(snapshot.record.pid) + " since " + snapshot.record.at
    : "an unreadable record";

const timeoutError = (snapshot: LockSnapshot): Error =>
  new Error(
    "timed out after " +
      String(LOCK_TIMEOUT_MS) +
      "ms waiting for the cf dev inspector lock (held by " +
      describeHolder(snapshot) +
      ")",
  );

/**
 * Wait until no other cf dev holds the machine's inspector port.
 *
 * @remarks
 * The lock lives in this user's temp directory, so every worktree this user runs shares it. A record
 * is taken over only through {@link takeOver}, after its owner is gone or the record outlived
 * {@link LOCK_STALE_MS}; a live holder is waited for, at most {@link LOCK_TIMEOUT_MS}, and the wait
 * is logged so a slow suite explains itself.
 *
 * A wait that reaches the deadline first asks the inspector itself: when nothing is listening on
 * the port, the holder is not a cf dev and the record is taken over. A pid that outlives its lock
 * (a worker killed between writing the record and exiting) would otherwise stall every suite for
 * ten minutes, and the port is the only thing the lock protects.
 *
 * @throws Error when the lock is still held after {@link LOCK_TIMEOUT_MS}, or when this process
 * already holds it: a second cf dev would lose the inspector port to the first.
 */
const acquireLock = async (): Promise<InspectorLock> => {
  if (held !== undefined) {
    throw new Error("this process already holds the cf dev inspector lock; stop that cf dev first");
  }
  const token = randomUUID();
  const at = new Date().toISOString();
  const started = Date.now();
  const deadline = started + LOCK_TIMEOUT_MS;
  let announced = false;
  for (;;) {
    if (await createLock(token, at)) break;
    const current = await readLock();
    const ownerAlive = current.state === "held" && pidAlive(current.record.pid);
    const judgement = judgeLock(current, ownerAlive);
    if (judgement === "free") continue;
    if (judgement === "held") {
      // A holder that is not serving the inspector is not a cf dev, whatever its pid says: the
      // record outlived the process that wrote it. The port is what the lock protects, so a free
      // port is the evidence the lock is free too. The takeover still goes through its guard, so
      // two waiters cannot both take it.
      if (Date.now() >= deadline && mayTakeOverAfterDeadline(await canBind(INSPECTOR_PORT))) {
        const takeover = await takeOver(token, at, current);
        if (takeover.taken) {
          console.log(
            "[cf dev] took the inspector lock from " +
              describeHolder(current) +
              ": its port was free",
          );
          if (takeover.orphan !== undefined) await killAbandoned(takeover.orphan);
          break;
        }
      }
      if (Date.now() >= deadline) throw timeoutError(current);
      if (!announced) {
        console.log("[cf dev] waiting for the inspector lock held by " + describeHolder(current));
        announced = true;
      }
      await sleep(LOCK_POLL_MS);
      continue;
    }
    console.log("[cf dev] taking over the inspector lock abandoned by " + describeHolder(current));
    const takeover = await takeOver(token, at, current);
    if (!takeover.taken) {
      if (Date.now() >= deadline) throw timeoutError(current);
      await sleep(LOCK_POLL_MS);
      continue;
    }
    if (takeover.orphan !== undefined) await killAbandoned(takeover.orphan);
    break;
  }
  held = token;
  if (announced) {
    console.log("[cf dev] took the inspector lock after " + String(Date.now() - started) + "ms");
  }
  return {
    own: async (childPid) => {
      await writeLock(token, at, childPid);
    },
    release: async () => {
      await releaseLock(token);
    },
  };
};

/**
 * Whether a waiter whose deadline passed may take a lock the liveness check still calls held.
 *
 * @remarks
 * A worker killed between writing its record and starting cf dev leaves a record whose pid lives
 * on (reused, or a shell that outlived it) and a free inspector port. Waiting for
 * {@link LOCK_STALE_MS} would stall every suite for ten minutes for a process that is not there,
 * so the port decides: free means the holder is gone.
 *
 * @param portFree - Whether nothing is listening on the inspector port.
 * @returns Whether a takeover should be attempted before reporting the timeout.
 */
export const mayTakeOverAfterDeadline = (portFree: boolean): boolean => portFree;

const canBind = async (port: number): Promise<boolean> =>
  await new Promise<boolean>((resolveProbe) => {
    const server = createServer();
    server.once("error", () => resolveProbe(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolveProbe(true));
    });
  });

/** Take a port below the kernel's ephemeral range. */
const probePort = async (): Promise<number> => {
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    const port = PORT_BASE + Math.floor(Math.random() * PORT_SPAN);
    if (await canBind(port)) return port;
  }
  throw new Error("could not find a free port for cf dev");
};

/**
 * Wait until the inspector port can be bound.
 *
 * @remarks
 * The lock is released when cf dev exits, not when workerd has let the inspector go, so the port is
 * probed before the next spawn instead of leaning on the retry.
 */
const waitForInspector = async (): Promise<void> => {
  const deadline = Date.now() + INSPECTOR_WAIT_MS;
  let announced = false;
  while (!(await canBind(INSPECTOR_PORT))) {
    if (Date.now() >= deadline) {
      console.log(
        "[cf dev] the inspector port is still busy after " + String(INSPECTOR_WAIT_MS) + "ms",
      );
      return;
    }
    if (!announced) {
      console.log("[cf dev] waiting for the inspector port to be released");
      announced = true;
    }
    await sleep(HEALTH_POLL_MS);
  }
};

/** Keep what the child wrote, so a failure can quote it. */
const collect = (child: ChildProcess): Running => {
  let text = "";
  const append = (chunk: Buffer): void => {
    text += chunk.toString();
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  // A spawn failure arrives as an event; without a listener it would end the test process.
  child.on("error", (error) => {
    text += String(error);
  });
  return { child, output: () => text };
};

const spawnCfDev = (cwd: string, mode: string, port: number): Running => {
  const child = spawn(CF, ["dev", "--mode", mode, "--port", String(port)], {
    cwd,
    detached: true,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(cwd, "config"),
      XDG_CACHE_HOME: join(cwd, "cache"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return collect(child);
};

const waitForHealth = async (
  port: number,
  running: Running,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  const health = "http://127.0.0.1:" + String(port) + "/health";
  while (Date.now() < deadline) {
    if (running.child.exitCode !== null) return false;
    try {
      // Bound the probe: a socket that accepts but never answers must not outlast the deadline.
      const response = await fetch(health, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
};

/** Stop the child's whole group: cf dev runs wrangler, which runs workerd, and workerd holds 9229. */
const kill = async (running: Running | undefined): Promise<void> => {
  const child = running?.child;
  if (child === undefined) return;
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
  });
  signalGroup(pid, "SIGTERM");
  const escalate = setTimeout(() => signalGroup(pid, "SIGKILL"), KILL_TIMEOUT_MS);
  // A group that ignored SIGKILL would leave this waiting forever; the port is free either way.
  await Promise.race([exited, sleep(KILL_TIMEOUT_MS * 2)]);
  clearTimeout(escalate);
};

const handle = (started: Started, lock: InspectorLock): CfDev => {
  let stopping: Promise<void> | undefined;
  return {
    url: "http://127.0.0.1:" + String(started.port),
    port: started.port,
    output: started.running.output,
    stop: () => {
      stopping ??= (async () => {
        try {
          await kill(started.running);
        } finally {
          await lock.release();
        }
      })();
      return stopping;
    },
  };
};

/**
 * Start one cf dev.
 *
 * @remarks
 * The HTTP port is probed below the kernel's ephemeral range. The debug inspector is not: wrangler
 * fixes it at 9229 for every instance, so starts are serialized by a lock in this user's temp
 * directory that this call holds until {@link CfDev.stop}. Before spawning, the inspector port is
 * probed again, because the lock is released at cf dev's exit rather than at workerd's. A start that
 * still loses the inspector or its port retries once on a fresh HTTP port, inside the lock, and
 * throws with the child's output after that.
 *
 * Because the suites are serialized, a start inside a test queues behind the others: a test needs
 * {@link LOCK_TIMEOUT_MS} plus two ready windows per start, which the restart suites' 300s budget
 * covers for two starts.
 *
 * @throws Error when cf is not installed, when the lock is still held after {@link LOCK_TIMEOUT_MS},
 * or when both starts fail to answer `/health`.
 */
export async function startCfDev(options: CfDevOptions): Promise<CfDev> {
  if (!existsSync(CF)) throw new Error("cf is not installed");
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const lock = await acquireLock();
  /** One start; an exit or an unanswered health probe is reported as output, not an error. */
  const start = async (): Promise<Attempt> => {
    await waitForInspector();
    const port = await probePort();
    const running = spawnCfDev(options.cwd, DEFAULT_MODE, port);
    let ready: boolean;
    try {
      if (running.child.pid !== undefined) await lock.own(running.child.pid);
      ready = await waitForHealth(port, running, readyTimeoutMs);
    } catch (error) {
      // A start that could not be recorded still owns a process group; take it down first.
      await kill(running);
      throw error;
    }
    if (ready) return { ok: true, started: { running, port } };
    const output = running.output();
    await kill(running);
    console.log(
      "[cf dev] the start on port " +
        String(port) +
        " failed; its first lines were:\n" +
        output.split("\n").slice(0, 20).join("\n"),
    );
    return { ok: false, output };
  };
  try {
    const first = await start();
    if (first.ok) return handle(first.started, lock);
    const second = await start();
    if (second.ok) return handle(second.started, lock);
    throw new Error("cf dev did not become ready:\n" + second.output);
  } catch (error) {
    await lock.release();
    throw error;
  }
}
