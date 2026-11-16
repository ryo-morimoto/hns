import assert from "node:assert";
import { expect, test } from "vitest";
import type { WorkerEnv } from "../edge/env.ts";
import { credentialFor, priceFor, upstreamFor, type GatewayEnv } from "./env.ts";
import { routeFor } from "./providers.ts";

const env = (overrides: GatewayEnv = {}): GatewayEnv => ({
  HNS_GATEWAY_CALL_PRICE_USD: "1",
  OLLAMA_CLOUD_API_KEY: "ollama-key",
  OPENCODE_GO_API_KEY: "opencode-key",
  ...overrides,
});

// Catches: a provider key added to the harness env, which would undo the isolation.
type HarnessProviderCredential = Extract<
  keyof WorkerEnv,
  "OLLAMA_CLOUD_API_KEY" | "OPENCODE_GO_API_KEY" | "HNS_PROVIDER_KEY"
>;
type HarnessHasNoProviderCredential = HarnessProviderCredential extends never ? true : false;
const harnessHasNoProviderCredential: HarnessHasNoProviderCredential = true;

test("the harness env has no provider credential field", () => {
  expect(harnessHasNoProviderCredential).toBe(true);
});

test("each provider reads its own credential", () => {
  expect(credentialFor(env(), "ollama-cloud")).toBe("ollama-key");
  expect(credentialFor(env(), "opencode-go")).toBe("opencode-key");
  expect(credentialFor(env({ OLLAMA_CLOUD_API_KEY: "  " }), "ollama-cloud")).toBeUndefined();
  expect(credentialFor(env({ OPENCODE_GO_API_KEY: undefined }), "opencode-go")).toBeUndefined();
});

test("a price must be a positive number", () => {
  expect(priceFor(env())).toBe(1);
  expect(priceFor(env({ HNS_GATEWAY_CALL_PRICE_USD: " 0.25 " }))).toBe(0.25);
  expect(priceFor(env({ HNS_GATEWAY_CALL_PRICE_USD: "0" }))).toBeUndefined();
  expect(priceFor(env({ HNS_GATEWAY_CALL_PRICE_USD: "-1" }))).toBeUndefined();
  expect(priceFor(env({ HNS_GATEWAY_CALL_PRICE_USD: "free" }))).toBeUndefined();
  expect(priceFor(env({ HNS_GATEWAY_CALL_PRICE_USD: undefined }))).toBeUndefined();
});

test("the upstream stays on the route unless the deployment overrides it", () => {
  const ollama = routeFor("/v1/ollama-cloud/chat/completions");
  const opencode = routeFor("/v1/opencode-go/chat/completions");
  assert.ok(ollama !== undefined);
  assert.ok(opencode !== undefined);
  expect(upstreamFor(env(), ollama)).toBe(ollama.upstream);
  expect(
    upstreamFor(env({ HNS_GATEWAY_OLLAMA_CLOUD_URL: "http://127.0.0.1:8787/v1" }), ollama),
  ).toBe("http://127.0.0.1:8787/v1");
  expect(
    upstreamFor(env({ HNS_GATEWAY_OPENCODE_GO_URL: "https://staging.example/v1" }), opencode),
  ).toBe("https://staging.example/v1");
});

// Catches: a plaintext upstream that would put the provider key on the wire in clear text.
test("a plaintext upstream off loopback is refused", () => {
  const ollama = routeFor("/v1/ollama-cloud/chat/completions");
  assert.ok(ollama !== undefined);
  expect(() =>
    upstreamFor(env({ HNS_GATEWAY_OLLAMA_CLOUD_URL: "http://example.com/v1" }), ollama),
  ).toThrow(/https or loopback/u);
  expect(() =>
    upstreamFor(env({ HNS_GATEWAY_OLLAMA_CLOUD_URL: "ftp://example.com/v1" }), ollama),
  ).toThrow(/https or loopback/u);
  expect(() => upstreamFor(env({ HNS_GATEWAY_OLLAMA_CLOUD_URL: "not a url" }), ollama)).toThrow(
    /valid URL/u,
  );
});
