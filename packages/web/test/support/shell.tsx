import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { RelayEnvironmentProvider } from "react-relay";
import type { Environment } from "relay-runtime";
import { afterEach, beforeEach } from "vitest";
import { useProjectWorkspace } from "../../src/app/ProjectWorkspace.tsx";
import { Shell, type ShellProps } from "../../src/app/Shell.tsx";
import { createTestEnvironment, type GraphQLCall } from "./relay.ts";
import { workspaceFixture } from "./workspaceFixtures.ts";

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
 */
export function setupShellTestHooks(): void {
  beforeEach(() => {
    window.localStorage.clear();
    window.location.hash = "";
    setMobile(false);
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });
}

/** Render the shell over an environment the test owns, so requests can be counted. */
export function renderShellWith(environment: Environment, props: ShellProps = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <RelayEnvironmentProvider environment={environment}>
      <QueryClientProvider client={queryClient}>
        <Shell {...props} />
      </QueryClientProvider>
    </RelayEnvironmentProvider>,
  );
}

/** Render the shell over the fixture responder the shell tests share. */
export function renderShell(props: ShellProps = {}) {
  const { environment } = createTestEnvironment(workspaceFixture);
  return renderShellWith(environment, props);
}

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
