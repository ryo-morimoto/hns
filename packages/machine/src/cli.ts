import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import * as v from "valibot";
import { decodeDeviceKey, deviceKeyFingerprint, encodeDeviceKey } from "@hns/core";
import { startMachineAgent } from "./agent.ts";
import type { MachineAgent, MachineOfficeOptions } from "./agent.ts";
import { GrantCounter } from "./capability/counter.ts";
import type { ControlPlaneKeys } from "./control-plane.ts";

/**
 * `hns-machine`: the machine's two commands (0270n).
 *
 * @remarks
 * Every machine-side capability was implemented and nothing started it (0194's sandbox, 0246's
 * mirror, 0225's verifier, 0148's signed wire). This module is the start point:
 *
 * - **`enroll`** makes the machine's device key, keeps the secret in `<configDir>/device.json`
 *   (0700 directory, 0600 file) and prints the **public** half and its fingerprint, which a person
 *   pastes into `Mutation.registerMachine` (0148: the enrollment is a person's act, and the secret
 *   never leaves the machine). Its output **is** the next command's input: the same JSON carries the
 *   ROOT, the machine name, the agent URL, and the config directory, so
 *   `hns-machine run --enrollment <file>` starts the agent that key belongs to.
 * - **`run`** starts `startMachineAgent` with the control-plane keys the machine verifies inbound
 *   requests with, the grant counter under `<configDir>/grants`, and the ROOT it serves. The ROOT,
 *   the id, and the key must agree, or nothing starts: a machine that cannot verify its control
 *   plane is a machine the Worker cannot talk to, and starting it would only look like a machine
 *   that is up.
 *
 * **What stays a person's act.** `enroll` does not enroll: it prints. A person signs in to the
 * Worker and pastes the key, which is what makes enrollment an authorization (D087). There is no
 * enrollment token yet, so a machine cannot enroll itself; when that lands it is a third command,
 * not a flag on this one.
 *
 * **The keys.**
 *
 * - The **device key** is the machine's identity toward the Worker (`device.json`).
 * - The **control-plane public keys** are what the machine verifies the Worker's signatures with
 *   (0148's `/api/machines/keys`, and 0225's grant verification). `run` reads them from
 *   `<configDir>/control-plane.json`, which `enroll` does not create: a deployment fills it, or
 *   `run --control-plane-key <base64url seed>` derives the public half from the same seed the Worker
 *   signs with, which is what a single-machine self-host does.
 */

/** The default directory: `$HNS_CONFIG_DIR`, else `~/.config/hns` (the operator's alone). */
export const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "hns");

/** The device key's file, below the config directory. */
export const DEVICE_FILE = "device.json";

/** The enrolled control-plane keys' file, below the config directory. */
export const CONTROL_PLANE_FILE = "control-plane.json";

/** The mode of the config directory: the operator's alone (0194 hides it from the agent's shell). */
const DIRECTORY_MODE = 0o700;

/** The mode of every file the CLI writes: the operator's alone. */
const FILE_MODE = 0o600;

/** Bytes in an Ed25519 public key. */
const ED25519_PUBLIC_KEY_BYTES = 32;

/** The PKCS#8 prefix of an Ed25519 seed (up to its 32 bytes), which the Worker's secret holds. */
const PKCS8_PREFIX = Buffer.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/** What `enroll` prints and what `run` accepts: one document, so one command's output is the next's. */
export const EnrollmentOutputSchema = v.strictObject({
  /** The format version; a document without this one is not an output of this CLI. */
  v: v.literal(1),
  /** The machine's name in the registry (0148's `name`). */
  name: v.pipe(v.string(), v.minLength(1)),
  /** The machine's id, the one the Worker names in `HNS_MACHINE_ID` and every grant. */
  machineId: v.string(),
  /** The ROOT the agent serves; canonical at start, so `run` reads it as given. */
  root: v.string(),
  /** The machine's origin the Worker reaches it at (`HNS_AGENT_URL`), or empty when only local. */
  agentUrl: v.string(),
  /** The directory the device key and the counters live in. */
  configDir: v.string(),
  /** The device key's public half, base64url; the secret never appears here. */
  publicKey: v.string(),
  /** `ed25519:` + the first 16 bytes of the key's SHA-256 (0148). */
  fingerprint: v.string(),
  /** When the key was made (ISO 8601), for a person reading the output. */
  createdAt: v.string(),
});

/** One `enroll` output. */
export type EnrollmentOutput = v.InferOutput<typeof EnrollmentOutputSchema>;

/** The device key as the machine keeps it: the private half, and what a person pasted. */
const DeviceFileSchema = v.strictObject({
  v: v.literal(1),
  /** PKCS#8 DER, base64; never printed. */
  privateKey: v.pipe(v.string(), v.minLength(1)),
  /** The public half, base64url (43 characters). */
  publicKey: v.string(),
  fingerprint: v.string(),
  machineId: v.string(),
  name: v.string(),
  root: v.string(),
  agentUrl: v.string(),
  createdAt: v.string(),
});

/** The control-plane key list, as `run` reads it. */
const ControlPlaneFileSchema = v.strictObject({
  v: v.literal(1),
  /** The raw 32-byte public keys, base64url. A rotation lists the old and the new. */
  publicKeys: v.array(v.pipe(v.string(), v.minLength(1))),
});

/**
 * The exit code one command answers with.
 *
 * @remarks
 * The CLI is run by a person (and by a process supervisor): 0 means the command did what it says,
 * 1 means it refused, and 2 means the arguments were not understood. A refusal on stderr names what
 * to fix and never a key.
 */
export interface CliOutcome {
  readonly code: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

/** One parsed argument, as the commands take them. */
interface ParsedArgs {
  readonly command: "enroll" | "run" | undefined;
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
  /** The value list per flag, for a flag that may repeat (`--control-plane-key`). */
  readonly repeated: ReadonlyMap<string, readonly string[]>;
}

/** The argument grammar: each flag takes a value unless it is listed here. */
const BOOLEAN_FLAGS = new Set(["force", "help"]);

/** The failure a command refuses with. */
class CliRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliRefusal";
  }
}

/**
 * Parse `argv` (without the interpreter and the script name).
 *
 * @param argv - The command line after `hns-machine`.
 * @returns The command, its values, and its flags.
 * @throws Error for an unknown command, an unknown flag, or a flag with no value.
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0];
  if (command !== "enroll" && command !== "run" && command !== undefined) {
    throw new Error("unknown command: " + command);
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const repeated = new Map<string, string[]>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) break;
    if (!token.startsWith("--")) throw new Error("unexpected argument: " + token);
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.add(name);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--" + name + " needs a value");
    }
    index += 1;
    if (name === "control-plane-key") {
      const list = repeated.get(name) ?? [];
      list.push(value);
      repeated.set(name, list);
      continue;
    }
    values.set(name, value);
  }
  return { command, values, flags, repeated };
}
/**
 * Make a directory that is the operator's alone.
 *
 * @param path - The directory to create (and its parents).
 *
 * @remarks
 * `recursive` then `chmod`: an existing directory keeps its mode, and the config directory is the one
 * the agent's shell must not read (0194 hides the operator's home paths). A directory the CLI cannot
 * make is a refusal, not a warning: the key would otherwise be written somewhere else.
 */
async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(path, DIRECTORY_MODE);
}

/**
 * Write a file the operator alone can read, atomically.
 *
 * @param path - The destination.
 * @param text - The content.
 *
 * @remarks
 * A temp file at 0600, fsynced, then renamed: a reader never sees a half-written key, and the
 * destination never exists with a wider mode (a plain `writeFile` would create it at the umask for
 * an instant).
 */
async function writePrivateFile(path: string, text: string): Promise<void> {
  const temp = path + "." + String(process.pid) + ".tmp";
  const handle = await open(temp, "wx", FILE_MODE);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make (or read) the machine's device key.
 *
 * @param path - The `device.json` path.
 * @param force - Replace an existing key.
 * @returns The private key's PKCS#8 base64 and the raw public key.
 * @throws CliRefusal when a key exists and `force` is not given.
 *
 * @remarks
 * A second key is not an idempotent re-run: it is a **reimage** (the registry replaces the stored
 * key and revokes the old one), and a machine that quietly replaced its key would be a machine whose
 * registration silently stopped matching. So an existing file is a refusal unless the operator says
 * `--force`.
 */
async function deviceKey(): Promise<{ readonly privateKey: string; readonly publicKey: string }> {
  // The DER export is the pair's own bytes: no KeyObject reaches another call here, which keeps the
  // types to the raw forms both Node and WebCrypto read.
  const pair = generateKeyPairSync("ed25519");
  const spki = pair.publicKey.export({ format: "der", type: "spki" });
  // The raw public key is DER's tail, after the 12-byte SPKI prefix Node writes for Ed25519.
  const raw = new Uint8Array(spki.subarray(spki.length - ED25519_PUBLIC_KEY_BYTES));
  const pkcs8 = pair.privateKey.export({ format: "der", type: "pkcs8" });
  return { privateKey: pkcs8.toString("base64"), publicKey: encodeDeviceKey(raw) };
}

/**
 * `hns-machine enroll`: make the key and print what a person pastes.
 *
 * @param parsed - The parsed arguments.
 * @returns The enrollment document on stdout (JSON), or the refusal.
 *
 * @remarks
 * The ROOT is required and is the directory the agent will serve, not a project inside it. The name
 * defaults to the hostname and must satisfy 0148's name rule, so a value the registry would refuse
 * is refused here first. `--url` is printed for the person to copy into the Worker's
 * `HNS_AGENT_URL`; this command does not dial it.
 */
async function enroll(parsed: ParsedArgs): Promise<CliOutcome> {
  const configDir = configDirOf(parsed);
  const rootValue = parsed.values.get("root");
  if (rootValue === undefined) {
    throw new CliRefusal("--root is required: the directory the agent serves.");
  }
  const root = resolve(rootValue);
  const name = (parsed.values.get("name") ?? hostnameOf()).trim();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(name)) {
    throw new CliRefusal("--name must be lowercase letters, digits, and - (1-63 characters).");
  }
  const agentUrl = parsed.values.get("url") ?? "";
  if (agentUrl !== "" && !/^https:\/\/[^/\s]+$/u.test(agentUrl)) {
    throw new CliRefusal(
      "--url must be an https URL (the tunnel the Worker reaches the machine at).",
    );
  }
  const machineId = parsed.values.get("machine-id") ?? name;
  if (machineId.length === 0) throw new CliRefusal("--machine-id must not be empty.");
  await ensureDirectory(configDir);
  const devicePath = join(configDir, DEVICE_FILE);
  if (!parsed.flags.has("force") && (await exists(devicePath))) {
    throw new CliRefusal(
      "a device key already exists at " +
        devicePath +
        "; enrolling again replaces it (a reimage). Pass --force to replace it.",
    );
  }
  const key = await deviceKey();
  const fingerprint = await deviceKeyFingerprint(decodeDeviceKey(key.publicKey));
  const createdAt = new Date().toISOString();
  const device = {
    v: 1,
    privateKey: key.privateKey,
    publicKey: key.publicKey,
    fingerprint,
    machineId,
    name,
    root,
    agentUrl,
    createdAt,
  };
  await writePrivateFile(devicePath, JSON.stringify(device, null, 2) + "\n");
  const output: EnrollmentOutput = {
    v: 1,
    name,
    machineId,
    root,
    agentUrl,
    configDir,
    publicKey: key.publicKey,
    fingerprint,
    createdAt,
  };
  return {
    code: 0,
    stdout: JSON.stringify(output, null, 2) + "\n",
    stderr:
      "paste publicKey and fingerprint into Mutation.registerMachine (a signed-in person does this), " +
      "then start the agent with: hns-machine run --enrollment <this output>\n",
  };
}
/**
 * `hns-machine run`: start the agent the enrollment names.
 *
 * @param parsed - The parsed arguments.
 * @param onStarted - Called once the listener is bound, with the running agent.
 * @returns The start summary, or the refusal.
 *
 * @remarks
 * The enrollment is read from `--enrollment <file|->` when given, else from the device key the
 * config directory holds (the file `enroll` wrote, which carries the same fields). The
 * control-plane keys come from `--control-plane-key` (a base64url seed, whose public half is
 * derived) or `<configDir>/control-plane.json`; with neither, every inbound request would be
 * refused, so the command refuses to start instead of starting a machine nobody can call.
 *
 * The ROOT must be a real directory: `startMachineAgent` canonicalizes it and refuses otherwise,
 * and its refusal is this command's refusal, never a started agent that serves nothing.
 */
async function run(
  parsed: ParsedArgs,
  onStarted: (agent: MachineAgent) => void,
): Promise<CliOutcome> {
  const configDir = configDirOf(parsed);
  const enrollment = await readEnrollment(parsed, configDir);
  const controlPlane = await readControlPlane(parsed, configDir);
  // The control-plane keys are the verifier's own source (0147's `ControlPlaneKeys`): every inbound
  // request is checked against them, and a granted call is checked against the same list through
  // `enrolledGrantKeys` inside the agent. Passing a `GrantKeys` here (a `{publicKey(keyId)}` lookup)
  // is what a first draft did, and every request was a 500: the type is what keeps the two apart.
  const grants = {
    counter: new GrantCounter(join(configDir, "grants")),
  };
  const port = Number(parsed.values.get("port") ?? "8788");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliRefusal("--port must be an integer between 0 and 65535.");
  }
  const office = officeOptionsOf(process.env);
  let agent: MachineAgent;
  try {
    agent = await startMachineAgent({
      root: enrollment.root,
      machineId: enrollment.machineId,
      controlPlane,
      port,
      // The office engine is off unless the deployment says where its pack is. Turning it on is
      // one variable (`HNS_OFFICE_PACK`); the cache and the runs' directory have defaults outside
      // ROOT, because a preview is not part of the workspace (INV-O3).
      office,
      // No `keys`: the agent builds the grant lookup from the control-plane keys it was given
      // (`enrolledGrantKeys`), so one list is the machine's whole trust set.
      grants,
    });
  } catch (error) {
    throw new CliRefusal(
      "the agent did not start: " + (error instanceof Error ? error.message : "unknown error"),
    );
  }
  onStarted(agent);
  return {
    code: 0,
    stdout:
      JSON.stringify({
        v: 1,
        machineId: enrollment.machineId,
        root: enrollment.root,
        origin: agent.origin,
        exec: agent.shell.exec,
        grants: "on",
        agentUrl: enrollment.agentUrl,
      }) + "\n",
    stderr:
      "the machine agent is listening on " +
      agent.origin +
      " (exec: " +
      agent.shell.exec +
      "); the Worker reaches it at " +
      (enrollment.agentUrl === "" ? "<its tunnel URL>" : enrollment.agentUrl) +
      "\n",
  };
}

/**
 * The office engine, as the environment names it, or undefined when it is off.
 *
 * @param env - The process environment.
 * @returns The options `startMachineAgent` takes, with only the variables that are set.
 *
 * @remarks
 * `HNS_OFFICE_PACK` is the pack's directory and is what turns Office on at all; the other two name
 * the cache and the runs' directory, and neither has to be given. **Both are read together**: a
 * first draft returned after the first one it found, so naming `HNS_OFFICE_CACHE` silently dropped
 * `HNS_OFFICE_WORK`. An empty value means the same as an absent one. A pack path that is set but
 * wrong is not refused here: the agent answers `officeEngine` with the reason, which is what an
 * operator reads without restarting anything.
 */
export function officeOptionsOf(env: NodeJS.ProcessEnv): MachineOfficeOptions | undefined {
  const packRoot = env["HNS_OFFICE_PACK"];
  if (packRoot === undefined || packRoot === "") return undefined;
  const cacheRoot = namedDirectory(env["HNS_OFFICE_CACHE"]);
  const workRoot = namedDirectory(env["HNS_OFFICE_WORK"]);
  if (cacheRoot === undefined) {
    return workRoot === undefined ? { packRoot } : { packRoot, workRoot };
  }
  return workRoot === undefined ? { packRoot, cacheRoot } : { packRoot, cacheRoot, workRoot };
}

/**
 * One directory-name variable, or undefined when it is absent or empty.
 *
 * @param value - The variable's value.
 * @returns The value when it names a directory.
 *
 * @remarks
 * An empty value is what a shell writes for `HNS_OFFICE_CACHE=`, and it is not a directory: the
 * agent would then try to make `""`. Treating it as absent keeps the default.
 */
function namedDirectory(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** The config directory an invocation uses: `--config-dir`, else `$HNS_CONFIG_DIR`, else the default. */
function configDirOf(parsed: ParsedArgs): string {
  return resolve(
    parsed.values.get("config-dir") ?? process.env.HNS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR,
  );
}

/**
 * The machine's enrollment: the output document, or the device key file it was written to.
 *
 * @param parsed - The parsed arguments.
 * @param configDir - Where the device key is when `--enrollment` is not given.
 * @returns The enrollment.
 * @throws CliRefusal when neither source holds one, or when the document is not this CLI's.
 */
async function readEnrollment(parsed: ParsedArgs, configDir: string): Promise<EnrollmentOutput> {
  const from = parsed.values.get("enrollment");
  if (from !== undefined) {
    const text = from === "-" ? await readStdin() : await readFile(from, "utf8");
    const parsedDocument = v.safeParse(EnrollmentOutputSchema, JSON.parse(text));
    if (!parsedDocument.success) {
      throw new CliRefusal("the enrollment is not this CLI's output (v: 1, publicKey, root, ...).");
    }
    return parsedDocument.output;
  }
  const devicePath = join(configDir, DEVICE_FILE);
  let text: string;
  try {
    text = await readFile(devicePath, "utf8");
  } catch {
    throw new CliRefusal(
      "no device key at " +
        devicePath +
        ": run `hns-machine enroll --root <dir>` first, or pass --enrollment <file>.",
    );
  }
  const device = v.safeParse(DeviceFileSchema, JSON.parse(text));
  if (!device.success) throw new CliRefusal("the device key file is not this CLI's (v: 1).");
  return {
    v: 1,
    name: device.output.name,
    machineId: parsed.values.get("machine-id") ?? device.output.machineId,
    root: parsed.values.get("root") ?? device.output.root,
    agentUrl: device.output.agentUrl,
    configDir,
    publicKey: device.output.publicKey,
    fingerprint: device.output.fingerprint,
    createdAt: device.output.createdAt,
  };
}

/**
 * The control-plane public keys the machine verifies the Worker with.
 *
 * @param parsed - The parsed arguments.
 * @param configDir - Where the enrolled keys may be.
 * @returns The key source `startMachineAgent` takes.
 * @throws CliRefusal when there is no usable key: a machine that cannot verify is never started.
 *
 * @remarks
 * A seed (`--control-plane-key`) is what an operator already holds for the Worker's
 * `HNS_CONTROL_PLANE_KEY`; its public half is derived here, so a self-host needs no second file.
 * The file is the form a rotation uses: it lists every key the machine trusts.
 */
async function readControlPlane(parsed: ParsedArgs, configDir: string): Promise<ControlPlaneKeys> {
  const seeds = parsed.repeated.get("control-plane-key") ?? [];
  if (seeds.length > 0) {
    const raws = seeds.map((seed) => publicKeyOfSeed(seed));
    return { publicKeys: async () => raws };
  }
  const path = parsed.values.get("control-plane-file") ?? join(configDir, CONTROL_PLANE_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new CliRefusal(
      "no control-plane key: write " +
        path +
        " ({ v: 1, publicKeys: [...] }), or pass --control-plane-key <base64url seed>. " +
        "Starting without one would refuse every request the Worker signs.",
    );
  }
  const file = v.safeParse(ControlPlaneFileSchema, JSON.parse(text));
  if (!file.success) {
    throw new CliRefusal("the control-plane key file is not { v: 1, publicKeys: [...] }.");
  }
  const raws: Uint8Array[] = [];
  for (const key of file.output.publicKeys) {
    const raw = decodeKey(key);
    if (raw === undefined) {
      throw new CliRefusal("a control-plane key is not a 32-byte base64url Ed25519 key.");
    }
    raws.push(raw);
  }
  if (raws.length === 0) {
    throw new CliRefusal(
      "the control-plane key file lists no key: every request would be refused.",
    );
  }
  return { publicKeys: async () => raws };
}

/** The public half of an Ed25519 seed the Worker signs with (`HNS_CONTROL_PLANE_KEY`). */
function publicKeyOfSeed(seed: string): Uint8Array {
  const bytes = Buffer.from(seed.replace(/-/gu, "+").replace(/_/gu, "/"), "base64");
  if (bytes.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new CliRefusal("--control-plane-key is not a 32-byte base64url seed.");
  }
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, bytes]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  return new Uint8Array(spki.subarray(spki.length - ED25519_PUBLIC_KEY_BYTES));
}

/** Decode a base64url public key of exactly 32 bytes, or undefined. */
function decodeKey(text: string): Uint8Array | undefined {
  try {
    const decoded = decodeDeviceKey(text);
    return decoded.byteLength === ED25519_PUBLIC_KEY_BYTES ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** The local hostname, normalized to a registry name (0148's rule), or `machine`. */
function hostnameOf(): string {
  const name = hostname()
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, "-");
  const trimmed = name.replace(/-+/gu, "-").replace(/^-/u, "").replace(/-$/u, "");
  return trimmed.length === 0 ? "machine" : trimmed.slice(0, 63);
}

/** Read all of stdin. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The usage text. */
export const USAGE =
  "hns-machine enroll --root <dir> [--name <name>] [--machine-id <id>] [--url <https URL>]\n" +
  "                    [--config-dir <dir>] [--force]\n" +
  "hns-machine run [--enrollment <file|->] [--config-dir <dir>] [--root <dir>]\n" +
  "                [--machine-id <id>] [--control-plane-key <seed>]... [--control-plane-file <file>]\n" +
  "                [--port <port>]\n" +
  "\n" +
  "enroll makes the device key and prints what a person pastes into Mutation.registerMachine;\n" +
  "run starts the machine agent, and its input is the enroll output (or the same config directory).\n";

/**
 * Run one command line.
 *
 * @param argv - The arguments after the program name.
 * @param options - The seam a test replaces: the callback that receives the started agent.
 * @returns The outcome: stdout, stderr, and the exit code.
 *
 * @remarks
 * Nothing here prints a secret: `enroll` prints the public half and the fingerprint, and `run`
 * prints the origin and the exec verdict. A refused command prints what to fix on stderr and
 * exits 1; a command line this module does not understand exits 2.
 */
export async function runCli(
  argv: readonly string[],
  options: { readonly onStarted?: ((agent: MachineAgent) => void) | undefined } = {},
): Promise<CliOutcome> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    return {
      code: 2,
      stdout: "",
      stderr: (error instanceof Error ? error.message : "invalid arguments") + "\n" + USAGE,
    };
  }
  if (parsed.command === undefined) {
    return { code: parsed.flags.has("help") ? 0 : 2, stdout: USAGE, stderr: "" };
  }
  if (parsed.flags.has("help")) return { code: 0, stdout: USAGE, stderr: "" };
  const started = options.onStarted ?? (() => undefined);
  try {
    if (parsed.command === "enroll") return await enroll(parsed);
    return await run(parsed, started);
  } catch (error) {
    if (error instanceof CliRefusal) return { code: 1, stdout: "", stderr: error.message + "\n" };
    if (error instanceof SyntaxError) {
      return { code: 1, stdout: "", stderr: "a file the CLI read is not JSON\n" };
    }
    return {
      code: 1,
      stdout: "",
      stderr:
        "the command failed: " + (error instanceof Error ? error.message : "unknown error") + "\n",
    };
  }
}
