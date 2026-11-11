import { expect, test } from "vitest";
import { readBody } from "./body.ts";

function post(body: BodyInit | null, headers: Record<string, string>): Request {
  return new Request("https://hns.test/graphql", { method: "POST", body, headers });
}

test("a JSON body within the limit is decoded", async () => {
  const result = await readBody(
    post('{"query":"{ok}"}', { "content-type": "application/json" }),
    100,
  );
  expect(result).toStrictEqual({ ok: true, text: '{"query":"{ok}"}' });
});

test("a body without a JSON content type is refused", async () => {
  const result = await readBody(post("{}", { "content-type": "text/plain" }), 100);
  expect(result).toStrictEqual({ ok: false, code: "unsupported_media_type" });
});

test("a JSON content type with a charset is accepted", async () => {
  const result = await readBody(
    post("{}", { "content-type": "application/json; charset=utf-8" }),
    100,
  );
  expect(result.ok).toBe(true);
});

test("a declared length over the limit is refused", async () => {
  const request = post("{}", {
    "content-type": "application/json",
    "content-length": "1000",
  });
  const result = await readBody(request, 10);
  expect(result).toStrictEqual({ ok: false, code: "payload_too_large" });
});

// Catches: trusting Content-Length and reading an oversized stream.
test("a stream over the limit is refused even without Content-Length", async () => {
  const request = post("0123456789", { "content-type": "application/json" });
  request.headers.delete("content-length");
  const result = await readBody(request, 4);
  expect(result).toStrictEqual({ ok: false, code: "payload_too_large" });
});

test("an empty JSON body is an empty string", async () => {
  const request = new Request("https://hns.test/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  expect(await readBody(request, 100)).toStrictEqual({ ok: true, text: "" });
});
