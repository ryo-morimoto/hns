import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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

/** The lock every start takes; wrangler fixes one inspector port for every cf dev on the machine. */
const LOCK_PATH = join(tmpdir(), "hns-cf-dev-inspector.lock");
/** The short-lived guard that makes a takeover exclusive. */
const TAKEOVER_PATH = LOCK_PATH + ".takeover";

/** A record whose owner is gone, or that is this old, was abandoned by a worker that died. */
const LOCK_STALE_MS = 10 * 60_000;
/** A guard section is three file operations; one left this long belongs to a dead worker. */
const TAKEOVER_STALE_MS = 5_000;

const LOCK_POLL_MS = 250;
const DEFAULT_MODE = "development";
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 120_000;
const HEALTH_POLL_MS = 100;
const HEALTH_TIMEOUT_MS = 2_000;
const KILL_TIMEOUT_MS = 5_000;
const KILL_POLLS = 50;
// Below the kernel's ephemeral range (32768 and up), so a probe cannot race an unrelated listener.
const PORT_BASE = 18_100;
const PORT_SPAN = 900;
const PORT_ATTEMPTS = 20;

/** Whether the cf CLI is installed, so a suite can skip instead of failing where it is not. */
export const isCfDevInstalled = (): boolean => existsSync(CF);

/** How to start one cf dev. */
export interface CfDevOptions {
  /** The cf project: its `cloudflare.config.ts`, entrypoint, and node_modules link. */
  cwd: string;
  /** The configuration mode cf evaluates; every suite runs the development mode. */
  mode?: string | undefined;
  /** Bind this HTTP port instead of probing for a free one. */
  port?: number | undefined;
  /** How long the child has to answer `/health` before the start counts as failed. */
  readyTimeoutMs?: number | undefined;
  /** How long a start waits for another suite's cf dev before throwing. */
  lockTimeoutMs?: number | undefined;
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

type Takeover =
  | { readonly taken: false }
  | { readonly taken: true; readonly orphan: LockRecord | undefined };

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

type LockRecord = v.InferOutput<typeof lockRecord>;

type LockView =
  | { readonly state: "absent" }
  | { readonly state: "held"; readonly record: LockRecord; readonly ageMs: number }
  | { readonly state: "unreadable"; readonly ageMs: number };

interface InspectorLock {
  /** Record the child, so a lock abandoned by a dead worker can free the inspector port. */
  own(childPid: number): Promise<void>;
  release(): Promise<void>;
}

/** The lock this process holds, so a second start fails instead of waiting on itself. */
let held: string | undefined;

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

const ageOf = async (path: string): Promise<number> => {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch {
    // The record went away under the read; the next probe sees the lock as free.
    return 0;
  }
};

const parseLock = (text: string): LockRecord | null => {
  try {
    const parsed = v.safeParse(lockRecord, JSON.parse(text));
    return parsed.success ? parsed.output : null;
  } catch {
    // A torn write is not a record; its age decides whether it can be taken over.
    return null;
  }
};

const readLock = async (): Promise<LockView> => {
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
  try {
    await writeFile(LOCK_PATH, JSON.stringify({ pid: process.pid, at, token }), { flag: "wx" });
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (errnoOf(error) !== "EEXIST") throw error;
    return false;
  }
};

const releaseLock = async (token: string): Promise<void> => {
  if (held !== token) return;
  held = undefined;
  const current = await readLock();
  if (current.state !== "held" || current.record.token !== token) return;
  try {
    await unlink(LOCK_PATH);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (errnoOf(error) !== "ENOENT") throw error;
  }
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

const describeHolder = (view: LockView): string =>
  view.state === "held"
    ? "pid " + String(view.record.pid) + " since " + view.record.at
    : "an unreadable record";

/**
 * Wait until no other cf dev holds the machine's inspector port.
 *
 * @remarks
 * The lock lives in the OS temp directory, so every worktree on the machine shares it. A record is
 * taken over when its owner is gone or the record outlived {@link LOCK_STALE_MS}; the takeover is
 * exclusive ({@link takeOver}) and a live holder is waited for, at most `timeoutMs`, with the wait
 * logged so a slow suite explains itself.
 *
 * @throws Error when the lock is still held after `timeoutMs`, or when this process already holds
 * it: a second cf dev would lose the inspector port to the first.
 */
const acquireLock = async (timeoutMs: number): Promise<InspectorLock> => {
  if (held !== undefined) {
    throw new Error("this process already holds the cf dev inspector lock; stop that cf dev first");
  }
  const token = randomUUID();
  const at = new Date().toISOString();
  const started = Date.now();
  const deadline = started + timeoutMs;
  let announced = false;
  for (;;) {
    if (await createLock(token, at)) break;
    const current = await readLock();
    if (current.state === "absent") continue;
    const abandoned =
      current.state === "unreadable"
        ? current.ageMs >= LOCK_STALE_MS
        : current.ageMs >= LOCK_STALE_MS || !pidAlive(current.record.pid);
    if (!abandoned) {
      if (Date.now() >= deadline) {
        throw new Error(
          "timed out after " +
            String(timeoutMs) +
            "ms waiting for the cf dev inspector lock held by " +
            describeHolder(current),
        );
      }
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
      if (Date.now() >= deadline) {
        throw new Error(
          "timed out after " +
            String(timeoutMs) +
            "ms waiting for the cf dev inspector lock held by " +
            describeHolder(current),
        );
      }
      await sleep(LOCK_POLL_MS);
      continue;
    }
    // Our record is in place, so this is the child the replaced record named.
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

/** Take a port below the kernel's ephemeral range. */
const probePort = async (): Promise<number> => {
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    const port = PORT_BASE + Math.floor(Math.random() * PORT_SPAN);
    const free = await new Promise<boolean>((resolveProbe) => {
      const server = createServer();
      server.once("error", () => resolveProbe(false));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolveProbe(true));
      });
    });
    if (free) return port;
  }
  throw new Error("could not find a free port for cf dev");
};

/** Remove a lock file, treating "already gone" as done. */
const remove = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (errnoOf(error) !== "ENOENT") throw error;
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
  const temporary = LOCK_PATH + "." + token + ".tmp";
  const record: LockRecord =
    child === undefined ? { pid: process.pid, at, token } : { pid: process.pid, at, token, child };
  try {
    await writeFile(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    await rename(temporary, LOCK_PATH);
  } catch (error) {
    await remove(temporary);
    throw error;
  }
};

/** Take the guard that makes read-then-replace exclusive, or report that another waiter has it. */
const takeGuard = async (): Promise<boolean> => {
  try {
    await writeFile(TAKEOVER_PATH, String(process.pid), { flag: "wx", mode: 0o600 });
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
 * Whether a snapshot still describes the record a takeover judged abandoned.
 *
 * @remarks
 * The guard makes the read and the replacement exclusive, but the record was judged before it was
 * taken: another waiter may have replaced it, or its owner may have released and a new holder
 * created. Only the record that was judged may be replaced, so a fresh record is never deleted.
 */
const sameRecord = (judged: LockView, current: LockView): boolean => {
  switch (judged.state) {
    case "absent":
      return current.state === "absent";
    case "unreadable":
      return current.state === "unreadable" && current.ageMs >= LOCK_STALE_MS;
    case "held":
      return current.state === "held" && current.record.token === judged.record.token;
  }
};

/**
 * Replace the record a start judged abandoned, exclusively.
 *
 * @remarks
 * The record is re-read inside the guard and only replaced when {@link sameRecord} still holds, so a
 * record another waiter already replaced is never touched. The new record exists before the orphan
 * is killed, so a process this start signals is the one the replaced record named.
 */
const takeOver = async (token: string, at: string, judged: LockView): Promise<Takeover> => {
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
 * fixes it at 9229 for every instance, so starts are serialized by an inter-process lock that this
 * call holds until {@link CfDev.stop}. A start that loses the inspector or its port to the machine
 * retries once on a fresh HTTP port, still inside the lock, and throws with the child's output
 * after that.
 *
 * Because the suites are serialized, a start inside a test queues behind the others; a test that
 * starts cf dev needs a timeout above this bound plus two ready windows, which the integration
 * suites allow with a few minutes each.
 *
 * @throws Error when cf is not installed, when the inspector lock is still held after
 * `lockTimeoutMs`, or when both starts fail to answer `/health`.
 */
export async function startCfDev(options: CfDevOptions): Promise<CfDev> {
  if (!existsSync(CF)) throw new Error("cf is not installed");
  const mode = options.mode ?? DEFAULT_MODE;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const lock = await acquireLock(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  /** One start; an exit or an unanswered health probe is reported as output, not an error. */
  const start = async (requested: number | undefined): Promise<Attempt> => {
    const port = requested ?? (await probePort());
    const running = spawnCfDev(options.cwd, mode, port);
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
    const first = await start(options.port);
    if (first.ok) return handle(first.started, lock);
    const second = await start(undefined);
    if (second.ok) return handle(second.started, lock);
    throw new Error("cf dev did not become ready:\n" + second.output);
  } catch (error) {
    await lock.release();
    throw error;
  }
}
