// The machine's exec surface: one command, run only inside the sandbox (D095).
//
// The agent builds this once at start. When the sandbox probe did not pass, the executor refuses
// every command with a typed refusal -- it never falls back to the host shell.
import { stat } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type {
  ExecutionEnv,
  ShellExecOptions,
  ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { SandboxReport } from "@hns/workspace/sandbox";
import { containInRoot } from "./containment.ts";
import { MachineRefusal } from "./refusal.ts";
import { createMachineSandboxEnv } from "./sandbox.ts";
import type { ExecRequest, ExecResult } from "./wire.ts";

/**
 * Runs one command in the machine's sandbox, or refuses because there is no sandbox.
 *
 * @remarks
 * `ready: false` is the fail-closed state (D095): the probe did not pass at start, so there is
 * no fence to put the command behind and the answer is a refusal. The reason is the probe's, so
 * an operator reads why in the answer and in the log.
 */
export type MachineExec =
  | { readonly ready: false; readonly reason: string }
  | {
      readonly ready: true;
      readonly env: ExecutionEnv;
      /** The probe's verdict, for the health answer and for tests. */
      readonly sandbox: SandboxReport;
    };

/** The context a sandboxed exec runs under: no aborts from outside, only its own deadline. */
const EXEC_CONTEXT = BACKGROUND_CONTEXT;

/**
 * Decide at start whether the machine may run commands, and build the way it runs them.
 *
 * @param env - The environment whose file API the machine keeps; only exec is wrapped.
 * @param options - The sandbox report, the project, and how to deliver a seccomp fd.
 * @returns A ready executor, or the refusal state with the probe's reason.
 * @throws {Error} When the project cannot be wrapped (an unusable root or project path).
 *
 * @remarks
 * The report decides, not the presence of bwrap: only a report whose probe ran the real wrapper
 * against a temporary root counts as `available`.
 *
 * The seccomp filter is **not** applied here. `bwrap --seccomp` reads an inherited fd, and the
 * exec this agent runs on (pi-durable's) hands the child stdio only, so a filter would make every
 * command fail with "Can't read seccomp data" rather than filter it. The filter stays built and
 * tested ({@link machineSeccompFilter}); wiring it needs an exec that can pass a descriptor, which
 * is recorded as follow-up work rather than faked here.
 */
export async function createMachineExec(
  env: ExecutionEnv,
  options: {
    readonly sandbox: SandboxReport;
    readonly root: string;
    readonly projectRoot: string;
    readonly home?: string | undefined;
    readonly egress?: "deny" | "inherit" | "allowlist" | undefined;
  },
): Promise<MachineExec> {
  if (!options.sandbox.available) return { ready: false, reason: options.sandbox.reason };
  const sandboxEnv = createMachineSandboxEnv(env, {
    root: options.root,
    projectRoot: options.projectRoot,
    home: options.home,
    egress: options.egress,
  });
  return { ready: true, env: sandboxEnv, sandbox: options.sandbox };
}

/**
 * Run one exec request under the machine's bounds.
 *
 * @param exec - The executor built at start.
 * @param request - The parsed command and its working directory.
 * @param budget - Bytes of output allowed, and the deadline that ends the command.
 * @returns The exit code and the combined output.
 * @throws {MachineRefusal} `forbidden` when there is no sandbox (it is never run unfenced),
 * `invalid_request` for a cwd outside ROOT, `too_large` for output over the bound,
 * `deadline_exceeded` when the command outlives the request, `internal` for anything the sandbox
 * could not decide.
 *
 * @remarks
 * The command's own output is bounded while it runs: the callback counts bytes and aborts the
 * request as soon as the bound is crossed, so a command that prints forever cannot fill memory.
 * The command is measured, never truncated.
 */
export async function runExec(
  exec: MachineExec,
  request: ExecRequest,
  budget: { readonly maxOutputBytes: number; readonly signal: AbortSignal; readonly root: string },
): Promise<ExecResult> {
  if (!exec.ready) {
    // 403 with the probe's reason: an operator can read why, and a caller must treat it as final.
    throw new MachineRefusal("forbidden", "exec is unavailable: " + exec.reason);
  }
  const cwd = await execCwd(budget.root, request.cwd);
  let bytes = 0;
  let output = "";
  let overflowed = false;
  const execOptions: ShellExecOptions = {
    cwd,
    onOutput: (text) => {
      bytes += Buffer.byteLength(text, "utf8");
      if (bytes > budget.maxOutputBytes) {
        overflowed = true;
        throw new MachineRefusal("too_large", "the command printed more than the response limit");
      }
      output += text;
    },
  };
  if (request.timeoutMs !== undefined) execOptions.timeout = request.timeoutMs / 1000;
  const result: ShellExecResult = getOrThrow(
    await exec.env.exec(request.args ?? request.command ?? "", execOptions, EXEC_CONTEXT),
  );
  if (overflowed) {
    throw new MachineRefusal("too_large", "the command printed more than the response limit");
  }
  return { exitCode: result.exitCode, output };
}

/**
 * Resolve a request's working directory to a canonical directory below ROOT.
 *
 * @param root - The canonical ROOT.
 * @param relative - The requested directory, ROOT-relative; absent means ROOT itself.
 * @returns The canonical path, which the sandbox then uses as its own cwd.
 * @throws {MachineRefusal} `invalid_request` when the path leaves ROOT or is not a directory.
 *
 * @remarks
 * The sandbox's own cwd rule would quietly replace an outside cwd with the root; a request that
 * names a directory the machine will not run in should be refused, not silently moved.
 */
async function execCwd(root: string, relative: string | undefined): Promise<string> {
  if (relative === undefined) return root;
  const contained = await containInRoot(root, relative);
  const info = await stat(contained.absolute).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) {
    throw new MachineRefusal(
      "invalid_request",
      relative + ": the working directory is not a directory",
    );
  }
  return contained.absolute;
}

/** The default environment an agent wraps: the host's files and processes. */
export function machineHostEnv(cwd: string): ExecutionEnv {
  return new NodeExecutionEnv({ cwd });
}
