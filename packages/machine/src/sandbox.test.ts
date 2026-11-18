// The machine's sandbox decisions that need no bubblewrap: what is hidden, what the shell's
// environment is, and the seccomp program's bytes.
import { expect, test } from "vitest";
import {
  machineHideList,
  machineSeccompFilter,
  machineShellEnv,
  readOnlyGitPaths,
  SECCOMP_ARCHES,
  seccompSupported,
} from "../src/sandbox.ts";
import { parseOperation } from "../src/wire.ts";

/** A request body as the wire receives it: bytes, not an object. */
const encodeOperation = (request: string): Uint8Array => new TextEncoder().encode(request);

/** The instruction at an index, as the 8-byte tuple the kernel reads. */
function instructionAt(filter: Uint8Array, index: number): readonly number[] {
  const view = new DataView(filter.buffer, filter.byteOffset, filter.byteLength);
  const at = index * 8;
  return [
    view.getUint16(at, true),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
    view.getUint32(at + 4, true),
  ];
}

// Catches: a hide list a caller could extend, or one that misses the directory holding the keys.
test("the machine hides a fixed list that always includes ~/.config/hns", () => {
  const hide = machineHideList("/home/operator");
  expect(hide).toContain("/home/operator/.config/hns");
  expect(hide).toContain("/home/operator/.ssh");
  expect(hide).toStrictEqual(machineHideList("/home/operator"));
  for (const path of hide) expect(path.startsWith("/home/operator/")).toBe(true);
});

// Catches: a shell that reads the operator's git config through HOME, or writes an index.
test("the shell's environment fixes TMPDIR and the git switches", () => {
  expect(machineShellEnv()).toStrictEqual({
    TMPDIR: "/tmp",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
  });
});

// Catches: a filter that kills instead of refusing, or one whose arch check lets another arch through.
test("the seccomp filter denies io_uring and AF_VSOCK with EPERM and allows the rest", () => {
  const filter = machineSeccompFilter("x64");
  expect(filter.byteLength).toBe(13 * 8);
  const ret = (index: number): number => instructionAt(filter, index)[3] ?? -1;
  // 0 loads arch, 1 compares it, 2 is the kill for another arch.
  expect(ret(1)).toBe(0xc000003e);
  expect(ret(2)).toBe(0x80000000);
  // 7 is the EPERM the three io_uring calls jump to; 11 the EPERM for AF_VSOCK; 12 is allow.
  expect(ret(7)).toBe(0x00050001);
  expect(ret(11)).toBe(0x00050001);
  expect(ret(12)).toBe(0x7fff0000);
});

// Catches: a jump that would land on the allow instead of the deny, which reads as a working filter.
test("every seccomp jump lands inside the program", () => {
  const filter = machineSeccompFilter("arm64");
  for (let index = 0; index < filter.byteLength / 8; index += 1) {
    const [code, jt, jf] = instructionAt(filter, index);
    if ((code ?? 0) !== 0x15) continue;
    for (const offset of [jt, jf]) {
      const target = index + 1 + (offset ?? 0);
      expect(target).toBeGreaterThanOrEqual(0);
      expect(target).toBeLessThan(filter.byteLength / 8);
    }
  }
});

// Catches: using the filter on an architecture whose syscall numbers it does not name.
test("seccomp is offered only on the architectures the filter names", () => {
  expect(SECCOMP_ARCHES).toStrictEqual(["x64", "arm64"]);
  expect(seccompSupported("x64")).toBe(true);
  expect(seccompSupported("arm64")).toBe(true);
  expect(seccompSupported("ia32")).toBe(false);
  expect(seccompSupported("riscv64")).toBe(false);
});

// Catches: binding a .git that is not there, which would make the wrapper fail to start.
test("a project without .git has no read-only path", () => {
  expect(readOnlyGitPaths("/nonexistent/project")).toStrictEqual([]);
});

// Catches: an exec request with no command, or one that would run something other than a command.
test("an exec request needs exactly one of command or args", () => {
  expect(parseOperation(encodeOperation('{"op":"exec","command":"ls"}'))).toMatchObject({
    op: "exec",
  });
  expect(parseOperation(encodeOperation('{"op":"exec","args":["ls","-l"]}'))).toMatchObject({
    op: "exec",
  });
  expect(() => parseOperation(encodeOperation('{"op":"exec"}'))).toThrow();
  expect(() => parseOperation(encodeOperation('{"op":"exec","args":[]}'))).toThrow();
  expect(() =>
    parseOperation(encodeOperation('{"op":"exec","command":"ls","timeoutMs":0}')),
  ).toThrow();
});
