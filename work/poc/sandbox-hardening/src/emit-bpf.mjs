// Emit the compiled seccomp filter as an array of 8-byte struct sock_filter
// records: work/poc/sandbox-hardening/bin/sandbox-hardening.bpf
//
// The artifact is committed so the test and the manual run pass a file to
// bwrap --seccomp and never compile anything at run time. Rebuild it with:
//
//   node work/poc/sandbox-hardening/src/emit-bpf.mjs
//
// There is no length header: bubblewrap 0.13.1 rejects the fd unless it is a
// whole number of 8-byte records, and it prepends the struct sock_fprog header
// itself. See src/seccomp.mjs for the policy.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildS7Filter, encodeSockFprog, verifyFilter } from "./seccomp.mjs";

const OUTPUT = join(import.meta.dirname, "..", "bin", "sandbox-hardening.bpf");

const program = buildS7Filter();
verifyFilter(program);
// encodeSockFprog writes a 2-byte length first; bwrap wants only the records.
const encoded = encodeSockFprog(program).subarray(2);
writeFileSync(OUTPUT, encoded);
process.stdout.write(`wrote ${OUTPUT} (${program.length} instructions, ${encoded.length} bytes)\n`);
