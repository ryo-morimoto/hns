import { describe, expect, test } from "vitest";
import { officePathOf } from "./office-path.ts";
// Catches: the server handing a path it has not checked to the machine (C1). The machine is one
// workspace, so a path that leaves this one would be resolved against the same ROOT there.
describe("a path that leaves the workspace is refused", () => {
  for (const path of [
    "../other/file.docx",
    "a/../../b.docx",
    "/etc/passwd.docx",
    "a\\b.docx",
    ".hns/secret.docx",
    "a//b.docx",
    "./a.docx",
    "",
  ]) {
    test(JSON.stringify(path), () => {
      const checked = officePathOf("project-1", path);
      expect(checked.ok).toBe(false);
      if (checked.ok) return;
      expect(checked.failure.code).toBe("not_authorized");
    });
  }
});

// Catches: a workspace the request names being ignored, and a path inside the workspace being
// refused (the refusal must not swallow what it is meant to allow).
test("a path inside the workspace is accepted, and an empty workspace is not", () => {
  expect(officePathOf("project-1", "提案書.docx")).toStrictEqual({
    ok: true,
    path: "提案書.docx",
  });
  expect(officePathOf("project-1", "docs/提案書.docx")).toStrictEqual({
    ok: true,
    path: "docs/提案書.docx",
  });
  expect(officePathOf("", "提案書.docx").ok).toBe(false);
});
// Catches: a NUL in a path passing the guard. The check must test the **character**, not the six
// letters of an escape sequence, so a JSON body a caller sends can spell a real NUL.
test("a path with a real NUL byte is refused", () => {
  const withNul = "a" + String.fromCharCode(0) + "b.docx";
  expect(withNul.length).toBe(8);
  const checked = officePathOf("project-1", withNul);
  expect(checked.ok).toBe(false);
  if (checked.ok) return;
  expect(checked.failure.code).toBe("not_authorized");
});
