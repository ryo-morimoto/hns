#!/run/current-system/sw/bin/sh
# Build the C probes. The binaries are committed because the integration test
# runs them; this script is what regenerates them, and the flags are fixed so a
# rebuild does not silently change what was measured.
#
#   sh work/poc/sandbox-hardening/src/build.sh
#
# gcc is part of NixOS's system profile; the probes use only libc and the
# kernel headers (linux/landlock.h, linux/seccomp.h) that ship with it.
set -eu
cd "$(dirname "$0")/.."
mkdir -p bin
for probe in probe-landlock probe-escape probe-syscalls; do
  gcc -O2 -Wall -Wextra -Werror -o "bin/$probe" "src/$probe.c"
done
node src/emit-bpf.mjs
echo "built bin/probe-landlock bin/probe-escape bin/probe-syscalls bin/sandbox-hardening.bpf"
