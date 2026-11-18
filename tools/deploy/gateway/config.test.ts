import { expect, test } from "vitest";
import { GATEWAY_ROUTES } from "../../../packages/server/src/gateway/providers.ts";
import { deploymentFor } from "../modes.ts";
import { gatewayWorkerFor } from "./cloudflare.config.ts";

const development = () => deploymentFor("development", undefined, undefined, "machine-dev");

test("the gateway is its own worker on the mode's database", () => {
  const worker = gatewayWorkerFor(
    deploymentFor("staging", "https://agent.example", "ollama/llama3", "machine-1"),
    {},
  );
  expect(worker.name).toBe("hns-stg-gateway");
  expect(worker.env.DB).toStrictEqual({ type: "d1", name: "hns-stg" });
  expect(worker.env).not.toHaveProperty("HNS_SESSION_SECRET");
  expect(worker.env).not.toHaveProperty("SESSION");
});

// Catches: a provider key declared anywhere but a secret on the gateway.
test("every provider credential is a secret binding", () => {
  const worker = gatewayWorkerFor(development(), {});
  for (const route of GATEWAY_ROUTES) {
    expect(worker.env, route.provider).toHaveProperty(route.credential);
    expect(worker.env[route.credential], route.provider).toStrictEqual({ type: "secret" });
  }
});

// Catches: an upstream that is not the provider's public endpoint, or one that a request could set.
test("the upstream defaults to the provider endpoint and can be overridden per deployment", () => {
  const defaults = gatewayWorkerFor(development(), {});
  for (const route of GATEWAY_ROUTES) {
    expect(defaults.env[route.upstreamVariable]).toStrictEqual({
      type: "text",
      value: route.upstream,
    });
  }
  const overridden = gatewayWorkerFor(development(), {
    HNS_GATEWAY_OLLAMA_CLOUD_URL: "http://127.0.0.1:8787/v1/chat/completions",
  });
  expect(overridden.env.HNS_GATEWAY_OLLAMA_CLOUD_URL).toStrictEqual({
    type: "text",
    value: "http://127.0.0.1:8787/v1/chat/completions",
  });
});

// Catches: a gateway published on its public workers.dev subdomain, which has no caller auth.
test("the gateway is not published on the public subdomain", () => {
  const worker = gatewayWorkerFor(development(), {});
  expect(worker.workersDev).toBe(false);
  expect(worker.previewUrls).toBe(false);
});

test("the call price is configured and validated at deploy time", () => {
  expect(gatewayWorkerFor(development(), {}).env.HNS_GATEWAY_CALL_PRICE_USD).toStrictEqual({
    type: "text",
    value: "0.01",
  });
  expect(
    gatewayWorkerFor(development(), { HNS_GATEWAY_CALL_PRICE_USD: "0.5" }).env
      .HNS_GATEWAY_CALL_PRICE_USD,
  ).toStrictEqual({ type: "text", value: "0.5" });
  expect(() => gatewayWorkerFor(development(), { HNS_GATEWAY_CALL_PRICE_USD: "0" })).toThrow(
    /HNS_GATEWAY_CALL_PRICE_USD/u,
  );
  expect(() => gatewayWorkerFor(development(), { HNS_GATEWAY_CALL_PRICE_USD: "free" })).toThrow(
    /HNS_GATEWAY_CALL_PRICE_USD/u,
  );
});
