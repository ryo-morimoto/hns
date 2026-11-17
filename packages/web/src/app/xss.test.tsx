import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toGlobalId } from "@hns/core/graphql";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { render, screen } from "@testing-library/react";
import { RelayEnvironmentProvider } from "react-relay";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createTestEnvironment, type Responder } from "../../test/support/relay.ts";
import { Shell } from "./Shell.tsx";

const PROJECT = toGlobalId("Project", "project-hns");
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

const responder: Responder = (call) => {
  if (call.operation === "ShellProjectsQuery") {
    return {
      projects: {
        __typename: "ProjectList",
        projects: [
          {
            id: PROJECT,
            name: '<img src=x onerror="window.__xss=1">',
            workspaceRoot: "",
            agentCwd: "",
            createdAt: "2026-11-01T00:00:00.000Z",
          },
        ],
      },
    };
  }
  if (call.operation === "ShellWorkspaceQuery") {
    return {
      conversations: {
        __typename: "ConversationList",
        conversations: [
          {
            id: toGlobalId("Conversation", "conversation-1"),
            projectId: PROJECT,
            title: "<script>window.__xss=2</script>",
          },
        ],
      },
      tasks: { __typename: "TaskList", tasks: [] },
    };
  }
  return undefined;
};

// Catches: a model field reaching the DOM as markup, which would reach exec through 0158.
test("a model field is rendered as text, not markup", async () => {
  window.location.hash = "#/p/project-hns/c/conversation-1";
  const { environment } = createTestEnvironment(responder);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <RelayEnvironmentProvider environment={environment}>
      <QueryClientProvider client={queryClient}>
        <Shell />
      </QueryClientProvider>
    </RelayEnvironmentProvider>,
  );

  expect(
    await screen.findByRole("heading", { name: "<script>window.__xss=2</script>" }),
  ).toBeTruthy();
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector("script")).toBeNull();
  expect("__xss" in window).toBe(false);
  expect(document.body.textContent ?? "").toContain('<img src=x onerror="window.__xss=1">');
});

/** The repository root, whether vitest runs from there or from the package. */
function repositoryRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, "packages/web/src"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repository root not found");
    dir = parent;
  }
}

/** Every source file under packages/web/src, excluding tests and generated artifacts. */
function webSources(): readonly string[] {
  const root = join(repositoryRoot(), "packages/web/src");
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__generated__") walk(path);
        continue;
      }
      if (!/\.(?:ts|tsx)$/u.test(entry.name) || entry.name.includes(".test.")) continue;
      files.push(path);
    }
  };
  walk(root);
  return files;
}

const SINKS = [
  /dangerouslySetInnerHTML/u,
  /\.innerHTML\b/u,
  /insertAdjacentHTML/u,
  /document\.write/u,
  /\beval\(/u,
  /new Function/u,
];

// Catches: a new HTML injection sink bypassing the text-only rendering above.
test("the web source has no HTML injection sink", () => {
  const offenders = webSources().flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return SINKS.some((sink) => sink.test(text)) ? [path] : [];
  });
  expect(offenders).toStrictEqual([]);
});

// Catches: an inline script in the shell, which the CSP would block at runtime.
test("the shell has no inline script", () => {
  const html = readFileSync(join(repositoryRoot(), "packages/web/index.html"), "utf8");
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/iu);
});
