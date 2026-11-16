import assert from "node:assert";
import type { D1Binding } from "@hns/store";
import * as v from "valibot";
import { expect, test } from "vitest";
import type { Budget, BudgetReservation } from "./budget.ts";
import type { GatewayEnv } from "./env.ts";
import { createGateway, type GatewayFetch } from "./handler.ts";
import gatewayWorker from "./index.ts";

const PATH = "/v1/ollama-cloud/chat/completions";
const KEY = "provider-key-do-not-leak";

/** A database the handler only forwards; the injected budget does the work. */
const stubDb = (): D1Binding => ({
  prepare: () => {
    throw new Error("the budget is injected in these tests");
  },
  batch: async () => [],
});

const baseEnv = (overrides: GatewayEnv = {}): GatewayEnv => ({
  DB: stubDb(),
  HNS_GATEWAY_CALL_PRICE_USD: "1",
  OLLAMA_CLOUD_API_KEY: KEY,
  ...overrides,
});

interface BudgetRecorder {
  readonly budget: Budget;
  readonly reserved: { amount: number; at: Date }[];
  readonly refunded: { amount: number; at: Date }[];
}

const recordingBudget = (
  result: BudgetReservation | Error = "reserved",
  refundError?: Error,
): BudgetRecorder => {
  const reserved: { amount: number; at: Date }[] = [];
  const refunded: { amount: number; at: Date }[] = [];
  return {
    reserved,
    refunded,
    budget: {
      async reserve(amount, at) {
        reserved.push({ amount, at });
        if (result instanceof Error) throw result;
        return result;
      },
      async refund(amount, at) {
        refunded.push({ amount, at });
        if (refundError !== undefined) throw refundError;
      },
    },
  };
};

interface UpstreamRecorder {
  readonly fetch: GatewayFetch;
  readonly calls: { url: string; init: RequestInit }[];
}

const recordingFetch = (respond: () => Response | Error): UpstreamRecorder => {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const response = respond();
      if (response instanceof Error) throw response;
      return response;
    },
  };
};

const ProblemCode = v.object({ code: v.string() });

const problemCode = async (response: Response): Promise<string> =>
  v.parse(ProblemCode, await response.json()).code;

const json = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

const call = (
  request: Request,
  env: GatewayEnv,
  dependencies: Parameters<typeof createGateway>[0],
): Promise<Response> => createGateway(dependencies)(request, env);

const post = (body = '{"model":"m"}', path = PATH, headers: Record<string, string> = {}): Request =>
  new Request("https://gateway.example" + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

const onlyCall = (recorder: UpstreamRecorder): { url: string; init: RequestInit } => {
  const [first] = recorder.calls;
  assert.ok(first !== undefined, "the provider should have been called once");
  assert.equal(recorder.calls.length, 1);
  return first;
};

test("a model call goes to the fixed upstream with the gateway's key", async () => {
  const upstream = recordingFetch(() => json('{"choices":[]}'));
  const budget = recordingBudget();
  const response = await call(post(), baseEnv(), {
    fetch: upstream.fetch,
    budgetFor: () => budget.budget,
  });
  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toBe('{"choices":[]}');
  const sent = onlyCall(upstream);
  expect(sent.url).toBe("https://ollama.com/v1/chat/completions");
  const headers = new Headers(sent.init.headers);
  expect(headers.get("authorization")).toBe("Bearer " + KEY);
  expect(headers.get("content-type")).toBe("application/json");
  expect(sent.init.body).toBe('{"model":"m"}');
  expect(budget.reserved.map((entry) => entry.amount)).toStrictEqual([1]);
  expect(budget.refunded).toStrictEqual([]);
});

// Catches: relaying caller headers, which would let a compromised harness swap the
// credential or smuggle a routing header to the provider.
test("the provider sees only the allowlisted caller headers", async () => {
  const upstream = recordingFetch(() => json("{}"));
  const budget = recordingBudget();
  const response = await call(
    post('{"model":"m"}', PATH, {
      authorization: "Bearer caller-key",
      "x-opencode-session": "session-1",
      "x-internal": "do-not-forward",
    }),
    baseEnv(),
    { fetch: upstream.fetch, budgetFor: () => budget.budget },
  );
  expect(response.status).toBe(200);
  const headers = new Headers(onlyCall(upstream).init.headers);
  expect(headers.get("authorization")).toBe("Bearer " + KEY);
  expect(headers.get("x-opencode-session")).toBe("session-1");
  expect(headers.get("x-internal")).toBeNull();
});

// Catches: an arbitrary-URL proxy. The path is the whole routing table.
test("a path outside the model routes is not a proxy", async () => {
  const upstream = recordingFetch(() => json("{}"));
  const budget = recordingBudget();
  const gateway = createGateway({ fetch: upstream.fetch, budgetFor: () => budget.budget });
  for (const path of [
    "/v1/evil/chat/completions",
    "/v1/ollama-cloud/chat/completions/",
    "/v1/ollama-cloud/other",
    "/",
  ]) {
    const response = await gateway(
      new Request("https://gateway.example" + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      baseEnv(),
    );
    expect(response.status, path).toBe(404);
  }
  expect(upstream.calls).toStrictEqual([]);
  expect(budget.reserved).toStrictEqual([]);
});

test("a query string cannot retarget the upstream", async () => {
  const upstream = recordingFetch(() => json("{}"));
  const budget = recordingBudget();
  const response = await call(
    post('{"url":"https://evil.example"}', PATH + "?url=https://evil.example"),
    baseEnv(),
    { fetch: upstream.fetch, budgetFor: () => budget.budget },
  );
  expect(response.status).toBe(200);
  expect(onlyCall(upstream).url).toBe("https://ollama.com/v1/chat/completions");
});

test("a method other than POST is refused", async () => {
  const upstream = recordingFetch(() => json("{}"));
  const budget = recordingBudget();
  const response = await call(new Request("https://gateway.example" + PATH), baseEnv(), {
    fetch: upstream.fetch,
    budgetFor: () => budget.budget,
  });
  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("POST");
  expect(upstream.calls).toStrictEqual([]);
  expect(budget.reserved).toStrictEqual([]);
});

test("a body that is not JSON is refused before any charge", async () => {
  const upstream = recordingFetch(() => json("{}"));
  const budget = recordingBudget();
  const response = await call(
    new Request("https://gateway.example" + PATH, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    }),
    baseEnv(),
    { fetch: upstream.fetch, budgetFor: () => budget.budget },
  );
  expect(response.status).toBe(415);
  expect(upstream.calls).toStrictEqual([]);
  expect(budget.reserved).toStrictEqual([]);
});

// Catches: a call over the limit still reaching the provider.
test("an over-budget call is 429 and never reaches the provider", async () => {
  const upstream = recordingFetch(() => json("{}"));
  const budget = recordingBudget("exceeded");
  const response = await call(post(), baseEnv(), {
    fetch: upstream.fetch,
    budgetFor: () => budget.budget,
  });
  expect(response.status).toBe(429);
  await expect(problemCode(response)).resolves.toBe("budget_exceeded");
  expect(upstream.calls).toStrictEqual([]);
});

test("the emergency stop is 503 and never reaches the provider", async () => {
  const upstream = recordingFetch(() => json("{}"));
  const budget = recordingBudget("stopped");
  const response = await call(post(), baseEnv(), {
    fetch: upstream.fetch,
    budgetFor: () => budget.budget,
  });
  expect(response.status).toBe(503);
  await expect(problemCode(response)).resolves.toBe("stopped");
  expect(upstream.calls).toStrictEqual([]);
  expect(budget.refunded).toStrictEqual([]);
});

test("a missing budget database fails closed", async () => {
  const upstream = recordingFetch(() => json("{}"));
  const budget = recordingBudget();
  const response = await call(post(), baseEnv({ DB: undefined }), {
    fetch: upstream.fetch,
    budgetFor: () => budget.budget,
  });
  expect(response.status).toBe(503);
  expect(upstream.calls).toStrictEqual([]);
  expect(budget.reserved).toStrictEqual([]);
});

// Catches: calling a provider with no credential (or with an empty one).
test("a missing provider credential fails closed before any charge", async () => {
  const upstream = recordingFetch(() => json("{}"));
  const budget = recordingBudget();
  const response = await call(post(), baseEnv({ OLLAMA_CLOUD_API_KEY: " " }), {
    fetch: upstream.fetch,
    budgetFor: () => budget.budget,
  });
  expect(response.status).toBe(503);
  expect(upstream.calls).toStrictEqual([]);
  expect(budget.reserved).toStrictEqual([]);
});

test("a missing call price fails closed", async () => {
  const upstream = recordingFetch(() => json("{}"));
  const budget = recordingBudget();
  const response = await call(post(), baseEnv({ HNS_GATEWAY_CALL_PRICE_USD: undefined }), {
    fetch: upstream.fetch,
    budgetFor: () => budget.budget,
  });
  expect(response.status).toBe(503);
  expect(upstream.calls).toStrictEqual([]);
  expect(budget.reserved).toStrictEqual([]);
});

test("a plaintext upstream override fails closed", async () => {
  const upstream = recordingFetch(() => json("{}"));
  const budget = recordingBudget();
  const response = await call(
    post(),
    baseEnv({ HNS_GATEWAY_OLLAMA_CLOUD_URL: "http://example.com" }),
    {
      fetch: upstream.fetch,
      budgetFor: () => budget.budget,
    },
  );
  expect(response.status).toBe(503);
  expect(upstream.calls).toStrictEqual([]);
});

// Catches: charging for a call the provider refused.
test("a provider error is relayed with its status and the charge is released", async () => {
  const upstream = recordingFetch(() => json('{"error":"quota"}', 429));
  const budget = recordingBudget();
  const response = await call(post(), baseEnv(), {
    fetch: upstream.fetch,
    budgetFor: () => budget.budget,
  });
  expect(response.status).toBe(429);
  await expect(response.text()).resolves.toBe('{"error":"quota"}');
  expect(budget.refunded.map((entry) => entry.amount)).toStrictEqual([1]);
});

// Catches: a network failure leaving the call charged.
test("a provider that cannot be reached is 502 and the charge is released", async () => {
  const upstream = recordingFetch(() => new Error("network down"));
  const budget = recordingBudget();
  const response = await call(post(), baseEnv(), {
    fetch: upstream.fetch,
    budgetFor: () => budget.budget,
  });
  expect(response.status).toBe(502);
  await expect(problemCode(response)).resolves.toBe("upstream");
  expect(budget.refunded).toHaveLength(1);
});

// Catches: reporting a clean failure while the charge may still be held.
test("a charge that cannot be released is a 503, not a clean failure", async () => {
  const upstream = recordingFetch(() => json("{}", 500));
  const budget = recordingBudget("reserved", new Error("d1 down"));
  const response = await call(post(), baseEnv(), {
    fetch: upstream.fetch,
    budgetFor: () => budget.budget,
  });
  expect(response.status).toBe(503);
  await expect(problemCode(response)).resolves.toBe("unavailable");
});

// Catches: leaking the provider key in a response, a header, or a problem body.
test("no response carries the provider key", async () => {
  const cases: Response[] = [];
  const success = recordingBudget();
  cases.push(
    await call(post(), baseEnv(), {
      fetch: recordingFetch(() => json('{"choices":[]}')).fetch,
      budgetFor: () => success.budget,
    }),
  );
  const failed = recordingBudget();
  cases.push(
    await call(post(), baseEnv(), {
      fetch: recordingFetch(() => json('{"error":"x"}', 500)).fetch,
      budgetFor: () => failed.budget,
    }),
  );
  cases.push(
    await call(post(), baseEnv(), {
      fetch: recordingFetch(() => json("{}")).fetch,
      budgetFor: () => recordingBudget("exceeded").budget,
    }),
  );
  for (const response of cases) {
    const text = await response.text();
    expect(text).not.toContain(KEY);
    for (const [name, value] of response.headers) {
      expect(name + ": " + value).not.toContain(KEY);
    }
  }
});

test("the entry module serves the gateway", async () => {
  const response = await gatewayWorker.fetch(
    new Request("https://gateway.example/nope"),
    baseEnv(),
  );
  expect(response.status).toBe(404);
});

test("the budget factory is the real D1 one by default", async () => {
  // A reserve against a database that cannot answer fails closed rather than spending.
  const upstream = recordingFetch(() => json("{}"));
  const response = await call(post(), baseEnv(), { fetch: upstream.fetch });
  expect(response.status).toBe(503);
  expect(upstream.calls).toStrictEqual([]);
});
