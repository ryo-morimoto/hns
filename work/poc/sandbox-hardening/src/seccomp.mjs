// seccomp BPF for the S7 probe.
//
// The filter is assembled here, once, and installed by bubblewrap (--seccomp)
// before exec. Node never calls prctl: it hands bwrap a compiled BPF program,
// and bwrap loads it into the sandboxed process. That is the shape the issue
// asks about ("BPF は事前コンパイルしたものを同梱（Node からは渡すだけ）").
//
// Denied with EPERM, never killed: a program that probes io_uring and falls
// back must keep its fallback, so the sandbox has to say "no" not "die".
// AF_VSOCK is refused in socket(2), so the family cannot be created at all.

/** One cBPF instruction, little endian, the struct sock_filter layout (8 bytes). */
// { code, jt, jf, k }

const BPF_LD = 0x00;
const BPF_JMP = 0x05;
const BPF_RET = 0x06;
const BPF_W = 0x00;
const BPF_ABS = 0x20;
const BPF_JEQ = 0x10;
const BPF_K = 0x00;

const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const EPERM = 1;

const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;

/** Offsets inside struct seccomp_data (linux/seccomp.h). */
const SECCOMP_DATA_NR = 0;
const SECCOMP_DATA_ARCH = 4;
/** socket(2) takes the address family in arg0, right after nr+arch. */
const SECCOMP_DATA_ARGS = 16;

const AF_VSOCK = 40;
/** socket(2) on every arch we name here; it is not a per-arch table entry. */
const SYS_SOCKET = 41;

const IO_URING = { setup: 425, enter: 426, register: 427 };

function stmt(code, k) {
  return { code, jt: 0, jf: 0, k };
}

function jump(code, k, jt, jf) {
  return { code, jt, jf, k };
}

function ret(action) {
  return stmt(BPF_RET | BPF_K, action);
}

const DENY = ret(SECCOMP_RET_ERRNO | (EPERM & 0xffff));

/**
 * Build the S7 filter: EPERM for io_uring_setup/enter/register and AF_VSOCK,
 * allow everything else.
 *
 * @param arch - The AUDIT_ARCH value this filter accepts. Any other arch exits
 * with KILL_PROCESS, so a compat call cannot dodge the table.
 * @returns The program in load order; encode with encodeSockFprog.
 *
 * @remarks
 * Jump offsets are written out below with the target index in a comment.
 * seccomp jump offsets are relative to the *next* instruction (jt/jf), so every
 * one of them is "target - (this + 1)"; verifyFilter() re-walks the program and
 * fails when an offset points outside the program, which is the failure mode that
 * matters (a filter that silently allows).
 */
export function buildS7Filter(arch = AUDIT_ARCH_X86_64) {
  if (arch !== AUDIT_ARCH_X86_64 && arch !== AUDIT_ARCH_AARCH64) {
    throw new Error("no syscall table for audit arch " + arch.toString(16));
  }
  return [
    /* 0 */ stmt(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_ARCH),
    /* 1 */ jump(BPF_JMP | BPF_JEQ | BPF_K, arch, 1, 0), // true: 3, false: 2
    /* 2 */ ret(SECCOMP_RET_KILL_PROCESS),
    /* 3 */ stmt(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_NR),
    /* 4 */ jump(BPF_JMP | BPF_JEQ | BPF_K, IO_URING.setup, 0, 1), // true: 5, false: 6
    /* 5 */ jump(BPF_JMP | BPF_JEQ | BPF_K, IO_URING.enter, 0, 1), // true: 6
    /* 6 */ jump(BPF_JMP | BPF_JEQ | BPF_K, IO_URING.register, 0, 1),
    /* 7 */ ret(SECCOMP_RET_ERRNO | (EPERM & 0xffff)), // the three io_uring calls land here
    /* 8 */ jump(BPF_JMP | BPF_JEQ | BPF_K, SYS_SOCKET, 0, 3), // true: 9, false: 12
    /* 9 */ stmt(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_ARGS),
    /* 10 */ jump(BPF_JMP | BPF_JEQ | BPF_K, AF_VSOCK, 0, 1), // true: 11
    /* 11 */ ret(SECCOMP_RET_ERRNO | (EPERM & 0xffff)),
    /* 12 */ ret(SECCOMP_RET_ALLOW),
  ];
}

/**
 * Walk the program and check every jump lands inside it.
 *
 * @param program - Instructions from buildS7Filter.
 * @returns True when every jt/jf stays within [0, program.length).
 * @throws {Error} When a jump leaves the program: fail closed, never ship it.
 *
 * @remarks
 * Jump offsets are relative to the following instruction; an offset that runs
 * past the end is a kernel EINVAL, but one that lands on the wrong instruction is
 * accepted and quietly changes the policy. Walking the offsets is what turns the
 * second kind into a test failure.
 */
export function verifyFilter(program) {
  for (const [index, instruction] of program.entries()) {
    if ((instruction.code & 0x07) !== BPF_JMP) continue;
    for (const offset of [instruction.jt, instruction.jf]) {
      const target = index + 1 + offset;
      if (target < 0 || target >= program.length) {
        throw new Error("jump at " + index + " lands at " + target + " outside the program");
      }
    }
  }
  return true;
}

/**
 * Encode a program as struct sock_fprog: u16 len, then 8-byte instructions.
 *
 * @param program - Instructions from buildS7Filter (call verifyFilter first).
 * @returns The buffer bubblewrap reads from the --seccomp fd.
 * @throws {Error} When the program is empty or longer than u16 permits.
 *
 * @remarks
 * The 8-byte record is code u16, jt u8, jf u8, k u32 on every architecture this
 * tool targets; the kernel reads struct sock_fprog, not a text format, so the
 * header is little endian like the host.
 */
export function encodeSockFprog(program) {
  if (program.length === 0 || program.length > 0xffff) {
    throw new Error("a filter has 1..65535 instructions (got " + program.length + ")");
  }
  const buffer = Buffer.alloc(2 + program.length * 8);
  buffer.writeUInt16LE(program.length, 0);
  program.forEach((instruction, index) => {
    const at = 2 + index * 8;
    buffer.writeUInt16LE(instruction.code, at);
    buffer.writeUInt8(instruction.jt, at + 2);
    buffer.writeUInt8(instruction.jf, at + 3);
    buffer.writeUInt32LE(instruction.k >>> 0, at + 4);
  });
  return buffer;
}
