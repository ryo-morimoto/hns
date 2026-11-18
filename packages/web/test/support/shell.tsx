/* oxlint-disable anti-slop/no-runtime-typeof -- the platform's fetch input is a Request,
   a URL, or a URL string; these stubs read which one they were given. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { RelayEnvironmentProvider } from "react-relay";
import type { Environment } from "relay-runtime";
import { afterEach, beforeEach } from "vitest";
import { useProjectWorkspace } from "../../src/app/ProjectWorkspace.tsx";
import { Shell, type ShellProps } from "../../src/app/Shell.tsx";
import { createTestEnvironment, type GraphQLCall } from "./relay.ts";
import { conversationFixture, workspaceFixture } from "./workspaceFixtures.ts";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const originalMatchMedia = window.matchMedia;

/** Pretend the viewport is (or is not) under the mobile breakpoint. */
export function setMobile(mobile: boolean): void {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: mobile && query.includes("max-width: 768px"),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
}

/**
 * Register the browser state every shell test starts from.
 *
 * @remarks
 * Call once at the top of a shell test file. A test starts on the desktop viewport, with no
 * stored theme and no route, and the media query stub never outlives it.
 *
 * The conversation route reads its conversation from `/api/conversations/:id/state` through the
 * browser's `fetch`. A shell test that mounts that route without stubbing `fetch` would leave
 * the screen in its loading state (jsdom's fetch has no server to answer), so a default answer
 * for that one route is installed here; a test that wants another answer stubs `fetch` itself,
 * before rendering, and its stub wins.
 */
export function setupShellTestHooks(): void {
  // The stub has to be in place before the tree renders (it is what answers the screen's one
  // read), so it is installed here, when the file loads. A test file's own `beforeEach` — which
  // runs after this call — can replace it, and its stub then wins for that test.
  installConversationStateStub();
  // A socket is a test's own seam: these hooks give every test a factory that opens nothing, so
  // a conversation route under the shell never reaches a real WebSocket. A test that wants a
  // socket passes its own factory to the shell, which wins over this one.
  liveSocket = idleSocket;
  beforeEach(() => {
    window.localStorage.clear();
    window.location.hash = "";
    setMobile(false);
    globalThis.fetch = stateFetch;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });
}

/** The `fetch` the hooks install; a different one afterwards is a test's own stub. */
let stateFetch: typeof globalThis.fetch = globalThis.fetch;

/** The socket factory the hooks hand a shell that names none. */
let liveSocket: ShellProps["liveSocket"] = undefined;

/** A socket that opens, sends, and closes without a network: the connection never becomes live. */
const idleSocket: NonNullable<ShellProps["liveSocket"]> = () => ({
  send: () => undefined,
  close: () => undefined,
  onopen: null,
  onmessage: null,
  onclose: null,
  onerror: null,
});

/** Answer the conversation state route from the shared workspace fixture. */
function installConversationStateStub(): void {
  stateFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const match = /^\/api\/conversations\/([^/]+)\/state$/u.exec(url);
    if (match === null) return new Response("not found", { status: 404 });
    const id = decodeURIComponent(match[1] ?? "");
    const conversation = conversationFixture(id);
    return conversation === undefined
      ? new Response(JSON.stringify({ ok: false, code: "not_found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      : new Response(JSON.stringify({ ok: true, conversation }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
  };
  globalThis.fetch = stateFetch;
}

/** Render the shell over an environment the test owns, so requests can be counted. */
export function renderShellWith(environment: Environment, props: ShellProps = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <RelayEnvironmentProvider environment={environment}>
      <QueryClientProvider client={queryClient}>
        {/*
          The shell must get the same factory object on every render: the live connection is
          created in an effect keyed on it, so a new function per render would drop and reopen
          the socket on every render of the shell.
        */}
        <Shell {...props} liveSocket={props.liveSocket ?? liveSocket} />
      </QueryClientProvider>
    </RelayEnvironmentProvider>,
  );
}

/** Render the shell over the fixture responder the shell tests share. */
export function renderShell(props: ShellProps = {}) {
  const { environment } = createTestEnvironment(workspaceFixture);
  return renderShellWith(environment, props);
}

/**
 * The socket factory the conversation screen mounts with.
 *
 * @remarks
 * Production gives the screen the browser's WebSocket through the shell. The shell tests have no
 * browser, so the shell's screen gets the factory the test named — one socket per visit, as in
 * production — or the hooks' idle one when the test named none.
 */

/** The editor-slot stand-in: it renders the project context the shell provides. */
export function RootProbe(): ReactElement {
  const workspace = useProjectWorkspace();
  return (
    <p data-testid="project-probe">
      {workspace === null
        ? "none"
        : workspace.projectId + ":" + workspace.workspaceRoot + ":" + workspace.agentCwd}
    </p>
  );
}

/** How many times the environment was asked for the operation. */
export function countOf(calls: readonly GraphQLCall[], operation: string): number {
  return calls.filter((call) => call.operation === operation).length;
}
