import { expect, test } from "vitest";
import { Denied, FileFailure } from "@hns/workspace";
import { failureOf, fixedKeySource, opencodeGo, ollamaCloud, readKey } from "../src/index.ts";
import { OLLAMA_DEFAULT_MODEL, OLLAMA_PROVIDER } from "../src/index.ts";
import { OPENCODE_DEFAULT_MODEL, OPENCODE_PROVIDER } from "../src/index.ts";

test("a key comes from the environment before any file", () => {
  const key = readKey(
    { env: "HNS_KEY", files: ["/a", "/b"] },
    fixedKeySource({ HNS_KEY: " from-env " }, { "/a": "from-file" }),
  );

  expect(key).toBe("from-env");
});

test("files are tried in order and blank values are skipped", () => {
  const key = readKey(
    { env: "HNS_KEY", files: ["/a", "/b"] },
    fixedKeySource({ HNS_KEY: "  " }, { "/a": "  ", "/b": "second" }),
  );

  expect(key).toBe("second");
});

test("no key anywhere is undefined, not an empty string", () => {
  expect(readKey({ env: "HNS_KEY", files: ["/a"] }, fixedKeySource({}, {}))).toBe(undefined);
});

test("a workspace refusal maps to a value and a bug does not", () => {
  expect(failureOf(new Denied("escapes root"))).toStrictEqual({
    ok: false,
    status: "denied",
    message: "escapes root",
  });
  expect(failureOf(new FileFailure("not_found", "missing"))).toStrictEqual({
    ok: false,
    status: "failed",
    code: "not_found",
    message: "missing",
  });
  expect(() => failureOf(new RangeError("bug"))).toThrow(RangeError);
});

test("the ollama adapter names its provider and model", () => {
  const built = ollamaCloud({ apiKey: "key" });

  expect(built.model).toBe(OLLAMA_DEFAULT_MODEL);
  expect(built.ref).toStrictEqual({ provider: OLLAMA_PROVIDER, modelId: OLLAMA_DEFAULT_MODEL });
});

test("the opencode adapter hands the key to pi-ai through the environment", () => {
  const previous = process.env.OPENCODE_API_KEY;
  const built = opencodeGo({ apiKey: "secret-key", model: "model-x" });

  expect(process.env.OPENCODE_API_KEY).toBe("secret-key");
  expect(built.ref).toStrictEqual({ provider: OPENCODE_PROVIDER, modelId: "model-x" });
  expect(OPENCODE_DEFAULT_MODEL).toBe("deepseek-v4.1-flash");
  if (previous === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = previous;
});
