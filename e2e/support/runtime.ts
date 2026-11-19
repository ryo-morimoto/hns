import { createServer } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { controlDatabase } from "./d1.ts";
import type { Project } from "@hns/core";
import { fromGlobalId } from "@hns/core/graphql";
import { parseProject } from "../../packages/store/src/parse.ts";
import { CONTROL_PLANE_SEED_B64 } from "./keys.ts";

/** The checkout, from this file: e2e/support/runtime.ts. */
export const REPO_ROOT = join(import.meta.dirname, "..", "..");

/**
 * What the runtime exposes to the journey's steps.
 *
 * @remarks
 * The alarm is run **between** the browser's page steps (one step: request the preview; the next:
 * run the alarm; the next: the page polls), so the browser's own polling — the app's one-second
 * poll, which draws `queued` → `ready` without a refresh — is what observes the result.
 */
export interface OfficeRuntime {
  readonly edgeOrigin: string;
  readonly machineOrigin: string;
  readonly projectId: string;
  /** Run the workspace's Session object's alarm, as the runtime's timer does. */
  readonly alarm: () => Promise<void>;
  /** Wait past the page's poll interval, so its own 1-second read draws the settled row. */
  readonly settle: () => Promise<void>;
  /** The Session objects this runtime constructed (their names). */
  readonly sessionNames: () => readonly string[];
  /** The office rows' states and codes (a failure's diagnosis; never a page's data). */
  readonly officeRowDetails: () => readonly Record<string, unknown>[];
  /** The office rows the Session keeps, for a failure's diagnosis (never for a page). */
  readonly officeRows: () => readonly Record<string, unknown>[];
  /** How many `office.job` rows the Session's audit has written, with their detail. */
  readonly officeJobs: () => readonly {
    readonly detail: Record<string, unknown>;
    readonly path: string | null;
  }[];
  /** The edge's project lookup's answer, for the assertion "the workspace exists". */
  readonly projects: () => Promise<Map<string, ProjectLike>>;
  /** Stop every listener and close the database. */
  readonly close: () => Promise<void>;
}

/** The one project the journey's edge knows (the shape the edge's project lookup returns). */
export interface ProjectLike {
  readonly id: string;
  readonly name: string;
  readonly workspace_root: string;
  readonly agent_cwd: string;
  readonly egress: string;
  readonly created_at: string;
}

/**
 * Start the machine and the edge the page talks to.
 *
 * @param options.packRoot - The office pack the machine runs (staged, never searched for).
 * @param options.workspaceRoot - The project's directory below the machine's ROOT (empty is ROOT).
 * @param options.projectId - The one project; the workspace id (D080).
 * @param options.cacheRoot - Where the machine keeps its derived previews.
 * @returns The origins, the project, and how to stop them.
 *
 * @remarks
 * **Every part of the path is the product's, with one boundary that is not: the Durable Object
 * dispatch.** The edge's `fetch` is the deployment's entrypoint, served on a loopback port; the
 * two object classes are the deployment's own classes; the machine is the product's agent; the
 * database answers with D1's interface. What the journey **models** is the runtime's dispatch:
 * one instance per object name, the object's SQLite state, and the alarm the platform fires.
 * That resolution is this file's, not workerd's.
 *
 * A run of the same entry under **real workerd** (miniflare) was built and worked — the edge,
 * both objects and the alarm all ran there — until it reached the store's `sql.batch`: inside a
 * request, workerd's `db.batch` did not return, though the same call completed at startup. The
 * store is not this issue's to change, and whether production D1 behaves the same is a defect of
 * its own, so the journey keeps the model and **this paragraph is the record**: a change that only
 * a real dispatch would catch is not something this journey proves.
 *
 * - The machine: `startMachineAgent` — its listener, its signed `op: "office"` and
 *   `GET /artifact`, its bubblewrap sandbox and its cache.
 * - The edge: the deploy project's Worker entrypoint (`packages/server/src/index.ts`, what
 *   `tools/deploy/worker.ts` re-exports), its `fetch` served on a loopback port, and its
 *   `Session` Durable Object class with one instance per project name — the resolution above.
 * - The database: the edge's `DB` binding over SQLite, with `prepare`/`batch` as D1 has them,
 *   so the edge's own `projectFor` reads the project.
 *
 * The static asset binding is the built `deploy/assets` (or a 404 when the caller gave none): the
 * page the browser opens is the build's own `index.html` and its bundle, so the shell, the lazy
 * chunks and the PDF.js worker all come from what the build shipped.
 */
export async function startOfficeRuntime(options: {
  readonly packRoot: string;
  readonly workspaceRoot: string;
  readonly projectId: string;
  readonly cacheRoot: string;
  /** Where the machine's ROOT is: the workspace files live here, with the project root below it. */
  readonly root: string;
  /** The edge's `ASSETS` binding: the built bundle, served as the deployment serves it. */
  readonly assets?: { readonly fetch: (request: Request) => Promise<Response> } | undefined;
}): Promise<OfficeRuntime> {
  const base = mkdtempSync(join(tmpdir(), "hns-e2e-office-"));
  const root = options.root;

  const machineModule = (await import(
    pathToFileURL(join(REPO_ROOT, "packages/machine/src/index.ts")).href
  )) as typeof import("@hns/machine");
  // The pack is bind-mounted into the sandbox, and bubblewrap refuses a symlink as a mount
  // destination: a checkout whose `office-pack` is a link to the build (the worktree layout)
  // is resolved here, the way a service manager hands a path to the agent.
  const { realpathSync } = await import("node:fs");
  const packRoot = realpathSync(options.packRoot);
  const { journeyKeys } = await import("./keys.ts");
  const machine = await machineModule.startMachineAgent({
    root,
    machineId: "machine-1",
    controlPlane: journeyKeys(),
    port: 0,
    limits: {},
    onLog: () => undefined,
    office: { packRoot, cacheRoot: options.cacheRoot },
  });

  const db = controlDatabase(options.projectId, options.workspaceRoot);
  const workspaceEntry = (await import(
    pathToFileURL(join(REPO_ROOT, "packages/server/src/do/workspace.ts")).href
  )) as typeof import("../../packages/server/src/do/workspace.ts");
  const entry = (await import(
    pathToFileURL(join(REPO_ROOT, "packages/server/src/index.ts")).href
  )) as {
    default: { fetch: (request: Request, env: unknown) => Promise<Response> };
    Session: SessionClass;
  };
  const objects = new Map<string, SessionInstance>();
  /**
   * When each object's last request started, for the alarm.
   *
   * @remarks
   * The runtime runs an alarm when the object is idle; one that arrives while a request is in
   * flight is deferred, not run concurrently. This models that: the journey's timer waits until
   * the page's own request has been answered and the object has gone quiet.
   */
  const objectBusy = new Map<string, { inFlight: number; lastAt: number }>();
  const workspaces = new Map<string, { fetch(request: Request): Promise<Response> }>();
  const objectStates = new Map<string, SqlStorage>();
  /** The alarm set on each object, so `alarm()` can run it the way a timer would. */
  const objectAlarms = new Map<string, { at: number | null }>();
  /** The clock each object was constructed with; a timer fires at its own deadline. */
  const objectClocks = new Map<string, { now: number }>();
  // Open the Session object the Worker's first answer is about, as the deployment's start-up pass
  // does: a constructed object begins opening itself, and the first request must find it ready.
  const open = (name: string): SessionInstance => {
    const existing = objects.get(name);
    if (existing !== undefined) return existing;
    // The object's own clock, so the runtime's timer can be run at the moment it armed: the
    // object reads its rows' deadlines and the alarm's next moment through it.
    const clock = { now: Date.now() };
    const state = objectState(name);
    objectStates.set(name, state.storage.sql);
    objectAlarms.set(name, state.alarm);
    objectClocks.set(name, clock);
    const instance = new entry.Session(state, env, undefined, { now: () => clock.now });
    objects.set(name, instance);
    return instance;
  };
  /**
   * The Session namespace, keyed by name.
   *
   * @remarks
   * The graph's office port reaches a Session object by the **global** project id (0237's
   * workspace name), while the edge's own session routes reach it by the project id. The
   * deployment has one project naming rule (`sessionNameFor`); the journey's graph id is not
   * that rule's input, so one namespace answers both names with one object per project.
   */
  const sessionNamespace = {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: (id: { toString?: () => string }) => {
      const key = typeof id.toString === "function" ? id.toString() : "";
      const object = open(objectsName(rawProjectIdOf(key)));
      return {
        fetch: async (request: Request) => {
          const busy = objectBusy.get(objectsName(rawProjectIdOf(key))) ?? {
            inFlight: 0,
            lastAt: 0,
          };
          busy.inFlight += 1;
          try {
            const answer = await object.fetch(request);
            if (process.env["HNS_E2E_DEBUG"] === "1" && !request.url.includes("/rpc/events")) {
              const url = new URL(request.url);
              console.error(
                "e2e session",
                JSON.stringify(key),
                request.method,
                url.pathname,
                answer.status,
              );
            }
            return answer;
          } finally {
            busy.inFlight -= 1;
            busy.lastAt = Date.now();
            objectBusy.set(objectsName(rawProjectIdOf(key)), busy);
          }
        },
      };
    },
  };
  const env: Record<string, unknown> = {
    HNS_ENV: "dev",
    HNS_SESSION_SECRET: "e2e-session-secret-0123456789abcdef",
    HNS_AGENT_URL: machine.origin,
    HNS_MACHINE_ID: "machine-1",
    HNS_CONTROL_PLANE_KEY: CONTROL_PLANE_SEED_B64,
    DB: db,
    SESSION: sessionNamespace,
    WORKSPACE: {
      // As the Session namespace: the runtime's id stringifies to its name, and the office's
      // version read addresses this object by the graph's workspace id.
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: (id: { name: string; toString?: () => string }) => {
        const object = workspaceObject(typeof id.toString === "function" ? id.toString() : id.name);
        return {
          fetch: async (request: Request) => {
            const answer = await object.fetch(request);
            if (process.env["HNS_E2E_DEBUG"] === "1") {
              console.error("e2e workspace", request.method, request.url, answer.status);
              if (!answer.ok) console.error("e2e workspace-body", await answer.clone().text());
            }
            return answer;
          },
        };
      },
    },
    ASSETS: options.assets ?? {
      fetch: async (): Promise<Response> =>
        new Response("no build was given to this journey", { status: 404 }),
    },
  };
  const workspace = objectsName(options.projectId);
  /** The Session object for a project: by its raw id, whatever name a caller used. */
  const sessionFor = (projectId: string): SessionInstance =>
    open(objectsName(rawProjectIdOf(projectId)));
  // The Workspace object each project's session reads its files' versions through (0237): one
  // object per project id, addressed exactly as the office port addresses it. It is constructed
  // with the runtime's state and the deployment's bindings, and its start-up (the version table,
  // the Trail lookup, the obs sink) runs on construction, as the runtime's does.
  const { officeObjectName } = (await import(
    pathToFileURL(join(REPO_ROOT, "packages/server/src/office/route.ts")).href
  )) as typeof import("../../packages/server/src/office/route.ts");
  const workspaceObject = (name: string): { fetch(request: Request): Promise<Response> } => {
    // The one naming rule the product uses: a raw project id and its graph id are one object.
    const key = "workspace:" + officeObjectName(name);
    let instance = workspaces.get(key);
    if (instance === undefined) {
      // SAFETY: the runtime constructs a Durable Object with its state and bindings; the state
      // this harness models is the part the object uses (SQLite, the alarm, the id).
      instance = new workspaceEntry.Workspace(
        objectState(key) as unknown as ConstructorParameters<typeof workspaceEntry.Workspace>[0],
        {
          ...(env as object),
          __workspace: { machineId: "machine-1" },
        } as unknown as ConstructorParameters<typeof workspaceEntry.Workspace>[1],
      );
      workspaces.set(key, instance);
    }
    return instance;
  };
  /**
   * The project's row, as the database holds it.
   *
   * @remarks
   * The graph names a workspace by its global id (`Project:<base64url>`); the control database
   * by the raw id inside it. Both the office port's lookup and the workspace id its version read
   * is addressed with go through this one function, so a project and its object are one name.
   */
  // The one substitution the deployment entry takes (0239): the office port's project lookup
  // reads this database. **It is given the same argument the product's own lookup is** — the
  // resolver's workspace, the graph's id — and it hands it to the same reader the product uses
  // (`officeProjectId`, which is read from the checkout's source), so this seam changes only
  // *where* the row comes from, never *which id* reaches it.
  const { officeProjectId } = (await import(
    pathToFileURL(join(REPO_ROOT, "packages/server/src/office/route.ts")).href
  )) as typeof import("../../packages/server/src/office/route.ts");
  (env as Record<string, unknown>)["__graphql"] = {
    officeProject: async (workspaceId: string): Promise<Project | undefined> => {
      const raw = officeProjectId(workspaceId);
      return raw === "" ? undefined : await projectOf(raw);
    },
    // The Session object one workspace is reached through: by the project inside the graph id,
    // so the office's route (whose query carries that id) reaches the object the project's
    // session routes reach.
    session: async (
      workspaceId: string,
    ): Promise<{ fetch(request: Request): Promise<Response> }> => {
      return sessionFor(workspaceId);
    },
  };
  /** One project's row, by the raw project id (the database's key). */
  const projectOf = async (projectId: string): Promise<Project | undefined> => {
    const rows = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(projectId).all();
    const row = rows.results[0];
    // The row is the wire's value; the projection is the model's (the store parses the same one).
    return row === undefined ? undefined : projectRowOf(row);
  };
  // The object's own start-up (alarms, sockets, the office rows) runs before anything asks it.
  open(workspace);
  // The edge is the deployment's own entry point (\`packages/server/src/index.ts\`, what
  // \`tools/deploy/worker.ts\` re-exports). Its GraphQL face reads the control database through
  // this journey's row lookup, behind the one seam the handler takes; every other face is the
  // deployment's.
  const edgeOrigin = await listen(async (request) => {
    const path = new URL(request.url).pathname;
    // A preview's bytes stream to the browser: they are passed through untouched, never read.
    if (path === "/api/office/preview") return await entry.default.fetch(request, env);
    const answer = await entry.default.fetch(request, env);
    if (path === "/graphql" || path.startsWith("/api/")) {
      const body = (await answer.clone().text()).slice(0, 200);
      console.error("e2e edge", request.method, path, answer.status, body);
    }
    return answer;
  });
  /** The office rows as they are stored (for the alarm's own log line). */
  const storageRows = (name: string): Record<string, unknown>[] => {
    const storage = objectStates.get(name);
    return storage === undefined ? [] : storage.exec("SELECT * FROM office_preview").toArray();
  };
  return {
    edgeOrigin,
    machineOrigin: machine.origin,
    projectId: options.projectId,
    alarm: async () => {
      // The runtime's timer, run to the moment each attempt armed. A row that arms a retry (a
      // machine that answered `stale`, say) is due at a later instant; the timer moves there,
      // as a clock would, and runs it again. What the page then polls is the settled row.
      const object = objects.get(workspace);
      const timer = objectAlarms.get(workspace);
      if (object === undefined || timer === undefined) return;
      const clock = objectClocks.get(workspace);
      const busy = objectBusy.get(workspace);
      if (clock === undefined) return;
      // Idle, as the runtime's alarm is: no request in flight, and the last one answered.
      for (let waited = 0; waited < 10_000; waited += 50) {
        if ((busy?.inFlight ?? 0) === 0 && Date.now() - (busy?.lastAt ?? 0) > 100) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await object.alarm();

      for (let round = 0; round < 5; round += 1) {
        clock.now = Math.max(clock.now, timer.at ?? clock.now);

        // Past the moment it armed: nothing due means the timer has nothing left to run.
        if (timer.at === null || timer.at <= clock.now) break;
      }
    },
    sessionNames: () => [...objects.keys()],
    /** The page polls a second after it requested the row: let its read observe the settled state. */
    settle: () => new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    officeRows: () => {
      const storage = objectStates.get(workspace);
      if (storage === undefined) return [];
      return storage
        .exec("SELECT * FROM office_preview")
        .toArray()
        .map((row) => JSON.parse(JSON.stringify(row)) as Record<string, unknown>);
    },
    officeRowDetails: () => {
      const storage = objectStates.get(workspace);
      if (storage === undefined) return [];
      return storage.exec("SELECT status, code, message, attempts FROM office_preview").toArray();
    },
    officeJobs: () => {
      const storage = objectStates.get(workspace);
      if (storage === undefined) return [];
      const rows = storage
        .exec("SELECT path, detail FROM obs_events WHERE event = 'office.job' ORDER BY id")
        .toArray();
      return rows.map((row) => ({
        path: typeof row["path"] === "string" ? row["path"] : null,
        // The log stores its detail as JSON; this parses it at the boundary, as a reader would.
        detail:
          typeof row["detail"] === "string"
            ? (JSON.parse(row["detail"]) as Record<string, unknown>)
            : {},
      }));
    },
    projects: async () => {
      const rows = await db.prepare("SELECT * FROM projects").all();
      const map = new Map<string, ProjectLike>();
      for (const row of rows.results) {
        const project = row as unknown as ProjectLike;
        map.set(project.id, project);
      }
      return map;
    },
    close: async () => {
      await machine.close();
      db.close();
    },
  };
}

// --- the runtime's Durable Object resolution, modelled -------------------------------

interface SessionInstance {
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
}

type SessionClass = new (
  state: object,
  env: Record<string, unknown>,
  open: undefined,
  dependencies: { readonly now: () => number },
) => SessionInstance;

/**
 * The project id a workspace id names.
 *
 * @param workspaceId - A raw project id, or the graph's `Project:<base64url>`.
 * @returns The raw id.
 *
 * @remarks
 * The office's routes carry the workspace name (the global id, 0237); the control database and
 * the machine ROOT are keyed by the raw id. The edge's project lookup is given whichever of the
 * two its caller has, and this is the one place that answers the raw one.
 */
function rawProjectIdOf(workspaceId: string): string {
  const decoded = fromGlobalId(workspaceId);
  return decoded.ok && decoded.value.type === "Project" ? decoded.value.id : workspaceId;
}

/** One project row as the store's model reads it (the columns the face uses). */
function projectRowOf(row: Record<string, unknown>): Project {
  return parseProject(row);
}

/** The part of the object's SQL storage the journey reads the audit through. */
export interface SqlStorage {
  exec(query: string): { toArray(): Record<string, unknown>[] };
}

/** The Session object's name one project addresses (its own id; `default` for the legacy one). */
function objectsName(projectId: string): string {
  return projectId;
}

/**
 * One Durable Object's state, over SQLite, with the alarm the runtime would fire.
 *
 * @param name - The object's name.
 * @returns The state the object is constructed with.
 *
 * @remarks
 * The runtime hands a Durable Object a state whose `storage` is SQLite and whose alarm is one
 * timestamp, plus `blockConcurrencyWhile`, `waitUntil`, and an id. This models exactly those: a
 * `node:sqlite` database in memory with the runtime's async statement interface, the alarm
 * remembered, and `waitUntil`'s promises drained by {@link drain}. Nothing else is invented — the
 * object's own tables, transactions and SQL are the product's.
 */
function objectState(name: string) {
  const db = new (require_sqlite().DatabaseSync)(":memory:");
  const pending = new Set<Promise<unknown>>();
  /** The alarm the runtime would fire at, as its storage keeps it. */
  const timer = { at: null as number | null };
  let queue: Promise<unknown> = Promise.resolve();
  const storage = {
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        const values = (bindings as unknown[]).map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        );
        const rows = db.prepare(query).all(...(values as never[])) as unknown[];
        let index = 0;
        return {
          next() {
            const value = rows[index];
            index += 1;
            return value === undefined ? { done: true as const } : { done: false as const, value };
          },
          toArray() {
            return rows.map((row) => ({ ...(row as Record<string, unknown>) }));
          },
        };
      },
    },
    transaction<T>(run: () => Promise<T>): Promise<T> {
      const result = queue.then(async () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const value = await run();
          db.exec("COMMIT");
          return value;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    getAlarm: async () => timer.at,
    setAlarm: async (at: number) => {
      timer.at = at;
    },
    deleteAlarm: async () => {
      timer.at = null;
    },
  };
  return {
    alarm: timer,
    id: { name, toString: () => name },
    storage,
    async blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T> {
      return await run();
    },
    waitUntil(promise: Promise<unknown>) {
      pending.add(promise);
      void promise.finally(() => pending.delete(promise));
    },
    abort() {},
    /** Wait for every promise the object handed the runtime so far. */
    async drain(): Promise<void> {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}

/** `node:sqlite`, loaded once. */
function require_sqlite(): typeof import("node:sqlite") {
  return process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
}

// --- a loopback listener for the Worker's fetch ------------------------------------

/**
 * Serve one Worker fetch on a loopback port.
 *
 * @param handle - The Worker's `fetch`.
 * @returns The origin.
 *
 * @remarks
 * The body is read before the request is built (a Worker's request has its bytes), and the
 * answer's body is written back whole. A preview is streamed by the Worker; the journey's
 * previews are small, and a buffer here is this harness's, not the product's.
 */
async function listen(handle: (request: Request) => Promise<Response>): Promise<string> {
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = chunks.length === 0 ? null : Buffer.concat(chunks);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers[key] = value;
        else if (Array.isArray(value)) headers[key] = value.join(", ");
      }
      const method = request.method ?? "GET";
      const answer = await handle(
        new Request("http://edge.internal" + (request.url ?? "/"), {
          method,
          headers,
          ...(body === null ? {} : { body: new Uint8Array(body) }),
        }),
      );
      const out: Record<string, string> = {};
      answer.headers.forEach((value, key) => {
        out[key] = value;
      });
      response.writeHead(answer.status, out);
      // A HEAD answer is its headers and no body: the panel asks it of the preview's route before
      // handing the route to PDF.js, and the runtime does not send bytes for it (0239).
      response.end(method === "HEAD" ? undefined : Buffer.from(await answer.arrayBuffer()));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : "failed");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return "http://127.0.0.1:" + String(port);
}
