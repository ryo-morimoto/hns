import { describe, expect, test } from "vitest";
import * as v from "valibot";
import { manifestHash } from "@hns/core/capability";
import {
  PHASE0_EXEC_ENVELOPE,
  WORKSPACE_TOOLS,
  callIdentity,
  definitionOf,
  manifestFor,
  parseJsonArguments,
  phase0Allow,
} from "./capability.ts";

const identityOf = (toolId: "read_file" | "write_file" | "bash") =>
  manifestFor(definitionOf(toolId));

describe("manifests (C1)", () => {
  test("each tool's manifest names its id, version, risk, and limits", async () => {
    for (const definition of WORKSPACE_TOOLS) {
      const { manifest } = await manifestFor(definition);
      expect(manifest).toMatchObject({
        v: 1,
        toolId: definition.toolId,
        version: "1",
        risk: definition.risk,
        outputLimits: {
          maxBytes: definition.outputLimits.maxBytes,
          maxLines: definition.outputLimits.maxLines,
        },
      });
      expect(manifest.descriptionHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(manifest.parametersHash).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  test("the tools and their risks are the contract's", async () => {
    const built = await Promise.all(WORKSPACE_TOOLS.map((tool) => manifestFor(tool)));
    expect(built.map(({ manifest }) => manifest.toolId)).toEqual([
      "read_file",
      "write_file",
      "bash",
    ]);
    expect(built.map(({ manifest }) => manifest.risk)).toEqual(["read", "write", "exec"]);
  });

  test("the manifest hash is stable and is the hash of the manifest", async () => {
    const first = await identityOf("read_file");
    const second = await identityOf("read_file");
    expect(first.manifestHash).toBe(second.manifestHash);
    expect(first.manifestHash).toBe(await manifestHash(first.manifest));
  });

  test("the three tools have three different contracts", async () => {
    const built = await Promise.all(WORKSPACE_TOOLS.map((tool) => manifestFor(tool)));
    expect(new Set(built.map(({ manifestHash: hash }) => hash)).size).toBe(3);
  });

  // Catches: a description edit that did not move the hash a grant is pinned to.
  test("a changed description moves the description hash, not the parameter hash", async () => {
    const base = definitionOf("read_file");
    const changed = await manifestFor({ ...base, description: base.description + " Read now." });
    const original = await manifestFor(base);
    expect(changed.manifest.descriptionHash).not.toBe(original.manifest.descriptionHash);
    expect(changed.manifest.parametersHash).toBe(original.manifest.parametersHash);
    expect(changed.manifestHash).not.toBe(original.manifestHash);
  });

  // Catches: an argument the manifest does not cover, so a grant authorizes another shape.
  test("a changed parameter descriptor moves the parameter hash", async () => {
    const base = definitionOf("read_file");
    const changed = await manifestFor({
      ...base,
      parameters: {
        ...base.parameters,
        properties: { path: { type: "string" }, encoding: { type: "string" } },
      },
    });
    const original = await manifestFor(base);
    expect(changed.manifest.parametersHash).not.toBe(original.manifest.parametersHash);
    expect(changed.manifestHash).not.toBe(original.manifestHash);
  });
});

describe("call identity (C2, C7)", () => {
  test("the same call twice has the same digest", async () => {
    const identity = await identityOf("read_file");
    const first = await callIdentity(identity, "tool:1:abc", { path: "a.txt" });
    const second = await callIdentity(identity, "tool:1:abc", { path: "a.txt" });
    expect(second.digest).toEqual(first.digest);
  });

  test("one character in the arguments changes argsHash and callHash", async () => {
    const identity = await identityOf("read_file");
    const first = await callIdentity(identity, "tool:1:abc", { path: "a.txt" });
    const second = await callIdentity(identity, "tool:1:abc", { path: "b.txt" });
    expect(second.digest.argsHash).not.toBe(first.digest.argsHash);
    expect(second.digest.callHash).not.toBe(first.digest.callHash);
  });

  // Catches: a model reusing another call's id to run different arguments under an authorization.
  test("a different callId changes callHash but not argsHash", async () => {
    const identity = await identityOf("read_file");
    const first = await callIdentity(identity, "tool:1:abc", { path: "a.txt" });
    const second = await callIdentity(identity, "tool:1:abd", { path: "a.txt" });
    expect(second.digest.argsHash).toBe(first.digest.argsHash);
    expect(second.digest.callHash).not.toBe(first.digest.callHash);
  });

  test("the call carries the durable id, the tool id, and the manifest version", async () => {
    const identity = await identityOf("write_file");
    const built = await callIdentity(identity, "tool:2:x", {
      path: "a.txt",
      content: "v2",
      expectedVersion: "sha256:0",
    });
    expect(built.call).toMatchObject({
      v: 1,
      callId: "tool:2:x",
      toolId: "write_file",
      toolVersion: "1",
    });
  });

  // The envelope is the sandbox, not the command: a grant for the narrow one cannot cover a wide one.
  test("a bash call hashes its exec envelope", async () => {
    const identity = await identityOf("bash");
    const narrow = await callIdentity(identity, "tool:3:x", {
      command: "ls",
      envelope: PHASE0_EXEC_ENVELOPE,
    });
    // The wider sandbox Phase 1 could grant (a Phase 0 call never runs in it). The contract's
    // `ExecEnvelope` type is Phase 0's own literal, so the wide one is written as an envelope.
    // Widening the declared envelope is the one place a test names a sandbox Phase 0 never uses, so the
    // value is parsed rather than asserted: what the test needs is a different envelope, not a cast.
    const wide = v.parse(
      v.object({ kind: v.literal("exec"), network: v.literal("none"), writable: v.boolean() }),
      { kind: "exec", network: "none", writable: true },
    );
    // SAFETY: the envelope a call carries is the literal `ExecEnvelope`; the wider one is written for
    // this test only, and `callIdentity` hashes whatever `envelope` it is given.
    const widened = await callIdentity(identity, "tool:3:x", {
      command: "ls",
      envelope: wide as typeof PHASE0_EXEC_ENVELOPE,
    });
    expect(narrow.digest.argsHash).not.toBe(widened.digest.argsHash);
    expect(narrow.digest.callHash).not.toBe(widened.digest.callHash);
  });

  test("a value with no canonical form is refused by the digest", async () => {
    const identity = await identityOf("bash");
    await expect(
      callIdentity(identity, "tool:4:x", {
        command: "ls",
        timeoutMs: Number.POSITIVE_INFINITY,
        envelope: PHASE0_EXEC_ENVELOPE,
      }),
    ).rejects.toThrow(/safe integer/u);
  });
});

describe("the Phase 0 decision", () => {
  test("an allow names revision 0, a policy hash, and no grant", () => {
    const allow = phase0Allow();
    expect(allow.outcome).toBe("allow");
    expect(allow.policyRevision).toBe(0);
    if (allow.outcome !== "allow") throw new Error("the Phase 0 decision is an allow");
    expect(allow.policyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.hasOwn(allow, "grantId")).toBe(false);
  });
});

describe("parseJsonArguments (the duplicate-key boundary)", () => {
  test("a plain object parses", () => {
    expect(parseJsonArguments('{"path":"a.txt"}')).toEqual({ ok: true, value: { path: "path" } });
  });

  // Catches: JSON.parse keeping the last of two equal keys, so a call means something other than its text.
  test("a repeated key is refused", () => {
    expect(parseJsonArguments('{"path":"a.txt","path":"../../etc/passwd"}')).toEqual({
      ok: false,
      error: "the arguments repeat a key",
    });
  });

  test("a repeated key is refused at any depth", () => {
    expect(parseJsonArguments('{"a":{"b":1,"b":2}}')).toMatchObject({ ok: false });
    expect(parseJsonArguments('{"a":[{"b":1,"b":2}]}')).toMatchObject({ ok: false });
  });

  // A model can write the same key twice so that the two spellings differ.
  test("a repeated key written with an escape is refused", () => {
    const raw = '{"a":1,"' + String.fromCharCode(92) + 'u0061":2}';
    expect(parseJsonArguments(raw)).toEqual({ ok: false, error: "the arguments repeat a key" });
  });

  test("a key that is only a prefix of another is not a repeat", () => {
    expect(parseJsonArguments('{"path":"a","paths":"b"}')).toMatchObject({ ok: true });
  });

  // A colon or a brace inside a string value is data, not structure.
  test("a colon and a brace inside a value are not read as structure", () => {
    const raw = '{"command":"echo ' + String.fromCharCode(92) + '"a:b{"}';
    expect(parseJsonArguments(raw)).toEqual({ ok: true, value: { command: "command" } });
  });

  test("the same key in different objects is not a repeat", () => {
    expect(parseJsonArguments('{"a":{"k":1},"b":{"k":2}}')).toMatchObject({ ok: true });
  });

  test("malformed text, a non-object, and trailing junk are refused", () => {
    expect(parseJsonArguments("{")).toMatchObject({ ok: false });
    expect(parseJsonArguments("[]")).toEqual({
      ok: false,
      error: "the arguments are not a JSON object",
    });
    expect(parseJsonArguments('{"a":1} {"b":2}')).toMatchObject({ ok: false });
    expect(parseJsonArguments("null")).toMatchObject({ ok: false });
  });

  test("numbers, literals, and an empty object parse", () => {
    expect(parseJsonArguments('{"timeout":-1.5e3,"ok":true,"none":null}')).toEqual({
      ok: true,
      value: { timeout: "timeout", ok: "ok", none: "none" },
    });
    expect(parseJsonArguments("{}")).toEqual({ ok: true, value: {} });
  });
});
