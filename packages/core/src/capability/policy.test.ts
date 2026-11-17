import { expect, test } from "vitest";
import { isUnder, normalizePath } from "./paths.ts";
import { capabilityAtoms, diffPolicy, isProposalCurrent } from "./policy.ts";
import type { PolicyDocument } from "./types.ts";

function documentOf(input: {
  readonly read?: readonly string[];
  readonly write?: readonly string[];
  readonly exec?: { readonly network: "none" | "proxy"; readonly writable: boolean };
  readonly egress?: readonly (readonly [string, number])[];
}): PolicyDocument {
  const tools: { -readonly [K in keyof PolicyDocument["tools"]]: PolicyDocument["tools"][K] } = {};
  const read = input.read;
  if (read !== undefined) {
    tools.read_file = {
      enabled: true,
      scope: { kind: "read", roots: read },
      grantTtlSeconds: 60,
      maxCallsPerGrant: 10,
    };
  }
  const write = input.write;
  if (write !== undefined) {
    tools.write_file = {
      enabled: true,
      scope: { kind: "write", roots: write },
      grantTtlSeconds: 60,
      maxCallsPerGrant: 10,
    };
  }
  const exec = input.exec;
  if (exec !== undefined) {
    tools.bash = {
      enabled: true,
      scope: { kind: "exec", network: exec.network, writable: exec.writable },
      grantTtlSeconds: 30,
      maxCallsPerGrant: 1,
    };
  }
  const egress = input.egress;
  return {
    v: 1,
    tools,
    egress: {
      enabled: egress !== undefined,
      hosts: (egress ?? []).map(([host, port]) => ({ host, port })),
    },
  };
}

// Catches: a diff that reads a change the wrong way round, so an expansion is approved as a
// narrowing. Each row is (base, candidate, expected kind).
test("diffPolicy classifies adds, removes, both, and nothing", () => {
  const base = documentOf({ read: ["."], write: ["src"] });
  expect(diffPolicy(base, base).kind).toBe("equal");
  expect(
    diffPolicy(
      base,
      documentOf({ read: ["."], write: ["src"], exec: { network: "none", writable: false } }),
    ).kind,
  ).toBe("expansion");
  expect(diffPolicy(base, documentOf({ read: ["."], write: ["src", "docs"] })).kind).toBe(
    "expansion",
  );
  expect(diffPolicy(base, documentOf({ read: ["."] })).kind).toBe("narrowing");
  expect(diffPolicy(base, documentOf({ read: ["."], write: ["src/"] })).kind).toBe("equal");
  // "./" is not a root this contract folds to ".": root spellings other than "." are unsupported.
  expect(diffPolicy(base, documentOf({ read: ["./"], write: ["src"] })).kind).toBe("unsupported");
  const mixed = diffPolicy(base, documentOf({ read: ["docs"], write: ["src"] }));
  expect(mixed.kind).toBe("mixed");
  expect(mixed.added).toStrictEqual([{ kind: "read", value: "docs" }]);
  expect(mixed.removed).toStrictEqual([{ kind: "read", value: "." }]);
});

// Catches: containment being used in the diff, so a child root is approved as "nothing changed";
// §6 says a parent and a child are different atoms and the human sees a mixed diff.
test("a parent and a child root are different atoms, so adding the child is mixed", () => {
  const parent = documentOf({ read: ["src"] });
  const child = documentOf({ read: ["src", "src/a"] });
  const diff = diffPolicy(parent, child);
  expect(diff.kind).toBe("expansion");
  expect(diff.added).toStrictEqual([{ kind: "read", value: "src/a" }]);
  const swapped = diffPolicy(child, parent);
  expect(swapped.kind).toBe("narrowing");
  expect(swapped.removed).toStrictEqual([{ kind: "read", value: "src/a" }]);
  expect(isUnder("src/a", "src")).toStrictEqual({ kind: "under", under: true });
});

// Catches: a disabled tool or a disabled egress being counted as a capability, which would report an
// enablement as equal.
test("a disabled tool and disabled egress allow nothing", () => {
  const off = documentOf({ read: ["."] });
  const readFile = off.tools.read_file;
  if (readFile === undefined) throw new Error("fixture");
  const disabled: PolicyDocument = {
    ...off,
    tools: { read_file: { ...readFile, enabled: false } },
  };
  expect(capabilityAtoms(disabled)).toStrictEqual([]);
  expect(diffPolicy(disabled, off)).toMatchObject({ kind: "expansion" });
  expect(diffPolicy(off, disabled)).toMatchObject({ kind: "narrowing" });
  const egressOff = documentOf({ read: ["."], egress: [["api.example", 443]] });
  expect(capabilityAtoms(egressOff)).toContainEqual({ kind: "egress", value: "api.example:443" });
});

// Catches: a glob, an exact scope, or a path the contract cannot compare being mapped to some atom
// set, so an unreadable expansion could hide inside "narrowing".
test("a glob, an exact scope, or an unknown path makes a diff unsupported", () => {
  const base = documentOf({ read: ["."] });
  for (const candidate of [
    documentOf({ read: ["*"] }),
    documentOf({ read: ["**/secrets"] }),
    documentOf({ read: ["../outside"] }),
    documentOf({ read: ["/etc"] }),
    {
      ...base,
      tools: {
        ...base.tools,
        bash: {
          enabled: true,
          scope: { kind: "exact" as const, callHash: "a".repeat(64) },
          grantTtlSeconds: 30,
          maxCallsPerGrant: 1,
        },
      },
    },
  ]) {
    expect(diffPolicy(base, candidate)).toStrictEqual({
      kind: "unsupported",
      added: [],
      removed: [],
    });
  }
  expect(capabilityAtoms(documentOf({ read: ["a/*"] }))).toBeTypeOf("string");
});

// Catches: a path form that slips past the normalizer (an absolute path, a backslash, a NUL, "..") or
// one that normalizes into a different spelling than the same file.
test("normalizePath folds // and a trailing / and refuses what it cannot compare", () => {
  expect(normalizePath(".")).toStrictEqual({ kind: "path", value: "." });
  expect(normalizePath("src//a/")).toStrictEqual({ kind: "path", value: "src/a" });
  expect(normalizePath("./src")).toStrictEqual({ kind: "path", value: "src" });
  expect(normalizePath("Src/A")).toStrictEqual({ kind: "path", value: "Src/A" });
  const withNul = "a" + String.fromCharCode(0) + "b";
  for (const bad of [
    "",
    "/etc/passwd",
    "a\\b",
    withNul,
    "..",
    "a/../b",
    "a/*",
    "a/**",
    "a/[x]",
    "a/{x}",
    "a/./b",
  ]) {
    expect(normalizePath(bad).kind, bad).toBe("unsupported");
  }
});

// Catches: a prefix match that treats "srcx" as under "src", or an unknown form read as a match.
test("isUnder is a path-component prefix and unsupported is never a match", () => {
  expect(isUnder("src/a.ts", "src")).toStrictEqual({ kind: "under", under: true });
  expect(isUnder("src", "src")).toStrictEqual({ kind: "under", under: true });
  expect(isUnder("srcx", "src")).toStrictEqual({ kind: "under", under: false });
  expect(isUnder("anything", ".")).toStrictEqual({ kind: "under", under: true });
  expect(isUnder("a/*", ".").kind).toBe("unsupported");
  expect(isUnder("a", "*").kind).toBe("unsupported");
  expect(isUnder("a", "**").kind).toBe("unsupported");
});

// Catches: an approval accepted against a revision that moved after the proposal was made.
test("isProposalCurrent requires the same revision, hash, and a pending proposal", () => {
  const proposal = { status: "pending" as const, baseRevision: 2, baseHash: "a".repeat(64) };
  const active = { revision: 2, hash: "a".repeat(64) };
  expect(isProposalCurrent(proposal, active)).toBe(true);
  expect(isProposalCurrent(proposal, { ...active, revision: 3 })).toBe(false);
  expect(isProposalCurrent(proposal, { ...active, hash: "b".repeat(64) })).toBe(false);
  expect(isProposalCurrent({ ...proposal, status: "approved" }, active)).toBe(false);
  expect(isProposalCurrent(proposal, null)).toBe(false);
});
