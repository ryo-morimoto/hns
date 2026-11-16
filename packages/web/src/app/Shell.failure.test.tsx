import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { RelayEnvironmentProvider } from "react-relay";
import { createTestEnvironment } from "../../test/support/relay.ts";
import { Shell } from "./Shell.tsx";

function renderWith(respond: Parameters<typeof createTestEnvironment>[0]) {
  const { environment } = createTestEnvironment(respond);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <RelayEnvironmentProvider environment={environment}>
      <QueryClientProvider client={queryClient}>
        <Shell />
      </QueryClientProvider>
    </RelayEnvironmentProvider>,
  );
}

// Catches: a typed failure rendered as an empty workspace, or its message leaking to the page.
test("a typed project failure is shown without the server's message", async () => {
  renderWith(() => ({
    projects: { __typename: "QueryFailure", code: "UNAVAILABLE", message: "internal detail" },
  }));
  expect(await screen.findByText("読み込めません")).toBeTruthy();
  expect(document.body.textContent ?? "").not.toContain("internal detail");
  expect(document.body.textContent ?? "").not.toContain("UNAVAILABLE");
});

// Catches: a failed workspace read shown as an empty conversation list.
test("a typed conversation failure is shown in the sidebar", async () => {
  renderWith((call) => {
    if (call.operation === "ShellProjectsQuery") {
      return {
        projects: {
          __typename: "ProjectList",
          projects: [{ id: "UHJvamVjdDpwcm9qZWN0LWhucw", name: "hns" }],
        },
      };
    }
    return {
      conversations: {
        __typename: "QueryFailure",
        code: "UNAVAILABLE",
        message: "internal detail",
      },
      tasks: { __typename: "TaskList", tasks: [] },
    };
  });
  expect(await screen.findByText("読み込めません")).toBeTruthy();
  expect(document.body.textContent ?? "").not.toContain("internal detail");
});

// Catches: a network failure unmounting the app with no way back.
test("a network failure shows the recovery screen", async () => {
  renderWith(() => undefined);
  expect(await screen.findByText("読み込めません")).toBeTruthy();
  expect(screen.getByRole("button", { name: "読み込み直す" })).toBeTruthy();
  expect(document.body.textContent ?? "").not.toContain("graphql request failed");
});
