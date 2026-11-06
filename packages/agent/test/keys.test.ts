import test from "node:test";
import assert from "node:assert/strict";
import { Denied, FileFailure } from "@hns/workspace";
import { failureOf, fixedKeySource, opencodeGo, ollamaCloud, readKey } from "../src/index.ts";
import { OLLAMA_DEFAULT_MODEL, OLLAMA_PROVIDER } from "../src/index.ts";
import { OPENCODE_DEFAULT_MODEL, OPENCODE_PROVIDER } from "../src/index.ts";

test("a key comes from the environment before any file", () => {
  const key = readKey(
    { env: "HNS_KEY", files: ["/a", "/b"] },
    fixedKeySource({ HNS_KEY: " from-env " }, { "/a": "from-file" }),
  );

  assert.equal(key, "from-env");
});

test("files are tried in order and blank values are skipped", () => {
  const key = readKey(
    { env: "HNS_KEY", files: ["/a", "/b"] },
    fixedKeySource({ HNS_KEY: "  " }, { "/a": "  ", "/b": "second" }),
  );

  assert.equal(key, "second");
});

test("no key anywhere is undefined, not an empty string", () => {
  assert.equal(readKey({ env: "HNS_KEY", files: ["/a"] }, fixedKeySource({}, {})), undefined);
});

test("a workspace refusal maps to a value and a bug does not", () => {
  assert.deepEqual(failureOf(new Denied("escapes root")), {
    ok: false,
    status: "denied",
    message: "escapes root",
  });
  assert.deepEqual(failureOf(new FileFailure("not_found", "missing")), {
    ok: false,
    status: "failed",
    code: "not_found",
    message: "missing",
  });
  assert.throws(() => failureOf(new RangeError("bug")), RangeError);
});

test("the ollama adapter names its provider and model", () => {
  const built = ollamaCloud({ apiKey: "key" });

  assert.equal(built.model, OLLAMA_DEFAULT_MODEL);
  assert.deepEqual(built.ref, { provider: OLLAMA_PROVIDER, modelId: OLLAMA_DEFAULT_MODEL });
});

test("the opencode adapter hands the key to pi-ai through the environment", () => {
  const previous = process.env.OPENCODE_API_KEY;
  const built = opencodeGo({ apiKey: "secret-key", model: "model-x" });

  assert.equal(process.env.OPENCODE_API_KEY, "secret-key");
  assert.deepEqual(built.ref, { provider: OPENCODE_PROVIDER, modelId: "model-x" });
  assert.equal(OPENCODE_DEFAULT_MODEL, "deepseek-v4.1-flash");
  if (previous === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = previous;
});
