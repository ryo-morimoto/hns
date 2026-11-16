import { expect, test } from "vitest";
import { workerFor } from "./cloudflare.config.ts";
import { deploymentFor } from "./modes.ts";

// Catches: a mode mapping that sends staging to the production Worker, or lets a missing URL/model through.

test("development uses the local defaults", () => {
  expect(deploymentFor("development", undefined, undefined)).toStrictEqual({
    mode: "development",
    env: "dev",
    workerName: "hns-dev",
    agentUrl: "http://127.0.0.1:8788",
    model: "faux/echo",
  });
});

test("staging and production use their own workers", () => {
  expect(deploymentFor("staging", "https://agent.example", "ollama/llama3").workerName).toBe(
    "hns-stg",
  );
  expect(deploymentFor("production", "https://agent.example", "ollama/llama3").workerName).toBe(
    "hns-prod",
  );
});

test("staging requires an https agent URL and a model", () => {
  expect(() => deploymentFor("staging", undefined, "ollama/llama3")).toThrow(/HNS_AGENT_URL/);
  expect(() => deploymentFor("staging", "http://agent.example", "ollama/llama3")).toThrow(/https/);
  expect(() => deploymentFor("staging", "https://agent.example", undefined)).toThrow(/HNS_MODEL/);
});

test("production requires an https agent URL and a model", () => {
  expect(() => deploymentFor("production", undefined, "ollama/llama3")).toThrow(/HNS_AGENT_URL/);
  expect(() => deploymentFor("production", "https://agent.example", undefined)).toThrow(
    /HNS_MODEL/,
  );
  expect(() => deploymentFor("production", "http://agent.example", "ollama/llama3")).toThrow(
    /https/,
  );
});

test("a missing mode is rejected", () => {
  expect(() => deploymentFor(undefined, undefined, undefined)).toThrow(/--mode/);
});

test("an unknown mode is rejected", () => {
  expect(() => deploymentFor("staging2", undefined, undefined)).toThrow(/unknown mode/);
});

// Catches: a face reading env.DB without a declared D1 binding.
test("the worker declares one D1 binding named for the worker", () => {
  const worker = workerFor(deploymentFor("development", undefined, undefined));
  expect(worker.env.DB).toStrictEqual({ type: "d1", name: "hns-dev" });
});

// Catches: the edge reading HNS_SESSION_SECRET without a declared binding.
test("the worker declares the session secret binding", () => {
  const worker = workerFor(deploymentFor("development", undefined, undefined));
  expect(worker.env).toHaveProperty("HNS_SESSION_SECRET");
  expect(worker.env).toHaveProperty("SESSION");
});

// Catches: a Workspace export the WORKSPACE binding cannot address, or vice versa.
test("the worker exports and binds the Workspace Durable Object", () => {
  const worker = workerFor(deploymentFor("development", undefined, undefined));
  expect(worker.exports.Workspace).toStrictEqual({
    type: "durable-object",
    storage: "sqlite",
  });
  expect(worker.env.WORKSPACE).toStrictEqual({
    type: "durable-object",
    worker: "hns-dev",
    exportName: "Workspace",
  });
});
// Catches: the object store reading env.OBJECTS without a declared R2 bucket binding.
test("the worker binds the object store bucket", () => {
  const worker = workerFor(deploymentFor("production", "https://agent.example", "ollama/llama3"));
  expect(worker.env.OBJECTS).toStrictEqual({ type: "r2", name: "hns-prod-objects" });
});

// Catches: a provider key added to the harness Worker's env, which would undo the isolation.
test("the harness worker declares no provider credential", () => {
  const worker = workerFor(deploymentFor("development", undefined, undefined));
  const names = Object.keys(worker.env);
  expect(names.filter((name) => /KEY|TOKEN|PROVIDER/u.test(name))).toStrictEqual([]);
  expect(names).toContain("HNS_SESSION_SECRET");
});

// Catches: the harness losing its only path to a model (the gateway service binding).
test("the harness worker binds the gateway service by name", () => {
  const worker = workerFor(deploymentFor("production", "https://agent.example", "ollama/llama3"));
  expect(worker.env.GATEWAY).toStrictEqual({ type: "worker", worker: "hns-prod-gateway" });
});
