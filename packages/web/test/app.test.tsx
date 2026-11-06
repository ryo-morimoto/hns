import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test } from "vitest";
import { App } from "../src/App.tsx";
import { createWebClient } from "../src/api/client.ts";
import { createFixtureFetch } from "../src/api/fixtures.ts";

function renderApp(fetchImpl: typeof fetch = createFixtureFetch()) {
  const client = createWebClient({ baseUrl: "", fetch: fetchImpl });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App client={client} />
    </QueryClientProvider>,
  );
}

test("the Workspace harness renders from fixtures without a server", async () => {
  renderApp();

  assert.equal(
    (await screen.findByRole("heading", { name: "Workspace" })).textContent,
    "Workspace",
  );
  assert.match((await screen.findByText(/faux-1/u)).textContent ?? "", /faux-1/u);
  assert.match((await screen.findByText(/2 projects/u)).textContent ?? "", /2 projects/u);
});

test("Refresh asks the server again", async () => {
  const fixtureFetch = createFixtureFetch();
  let calls = 0;
  const countingFetch: typeof fetch = async (input, init) => {
    calls += 1;
    return await fixtureFetch(input, init);
  };
  renderApp(countingFetch);

  await screen.findByText(/faux-1/u);
  assert.equal(calls, 1);

  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => {
    assert.equal(calls, 2);
  });
});

// Catches: a contract violation rendering as a blank screen instead of a visible error.
test("a contract violation is shown as an ApiError message", async () => {
  const badFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ messages: "not-an-array" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  renderApp(badFetch);

  const alert = await screen.findByRole("alert");
  assert.match(alert.textContent ?? "", /contract/u);
});
