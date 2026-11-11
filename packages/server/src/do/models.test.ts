import { expect, test } from "vitest";
import { ModelUnavailableError, modelsFor } from "./models.ts";

test("development builds the faux model", () => {
  const model = modelsFor({ HNS_ENV: "dev", HNS_MODEL: "faux/echo" });
  expect(model.model).toStrictEqual({ provider: "faux", modelId: "echo" });
});

// Catches: a deployment admitting work before a real provider exists.
test("staging and production fail closed", () => {
  expect(() => modelsFor({ HNS_ENV: "stg", HNS_MODEL: "faux/echo" })).toThrow(
    ModelUnavailableError,
  );
  expect(() => modelsFor({ HNS_ENV: "prod", HNS_MODEL: "faux/echo" })).toThrow(
    ModelUnavailableError,
  );
});

test("a non-faux model is refused in development", () => {
  expect(() => modelsFor({ HNS_ENV: "dev", HNS_MODEL: "ollama/llama" })).toThrow(
    ModelUnavailableError,
  );
  expect(() => modelsFor({ HNS_ENV: "dev", HNS_MODEL: "faux" })).toThrow(ModelUnavailableError);
});
