import assert from "node:assert/strict";
import { test } from "vitest";
import { createWebClient } from "../src/api/client.ts";
import { FIXTURE_ROUTE_KEYS, createFixtureFetch } from "../src/api/fixtures.ts";

// Catches: a fixture that no longer matches its route, which would break every screen using it.
test("every fixture parses against its route contract", async () => {
  const client = createWebClient({
    baseUrl: "",
    fetch: createFixtureFetch(),
  });

  for (const route of FIXTURE_ROUTE_KEYS) {
    await assert.doesNotReject(client.request(route));
  }
});
