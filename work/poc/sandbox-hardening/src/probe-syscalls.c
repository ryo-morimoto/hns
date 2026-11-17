/*
 * probe-syscalls: make one call and report its errno, so a seccomp filter can be
 * checked from the outside.
 *
 * Usage: probe-syscalls CALL...
 *   io_uring  io_uring_setup(1, NULL)      expect EPERM under S7
 *   vsock     socket(AF_VSOCK, ...)        expect EPERM under S7
 *   inet      socket(AF_INET, SOCK_STREAM) expect success; proves socket(2) is not blanket-denied
 *   file      open("/etc/hostname")        expect success; proves normal calls still work
 *
 * Prints one JSON object per call: {"call": ..., "ok": true|false, "errno": N}
 * Exit 0 always (the caller reads the objects); 1 when it cannot run.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

static int try_io_uring(void) { return (int)syscall(425 /* io_uring_setup */, 1, NULL); }
static int try_vsock(void) { return socket(40 /* AF_VSOCK */, SOCK_STREAM, 0); }
static int try_inet(void) { return socket(AF_INET, SOCK_STREAM, 0); }
static int try_file(void) { return open("/etc/hostname", O_RDONLY | O_CLOEXEC); }

static void report(const char *call, int fd) {
  if (fd >= 0) {
    printf("{\"call\":\"%s\",\"ok\":true}\n", call);
    close(fd);
  } else {
    printf("{\"call\":\"%s\",\"ok\":false,\"errno\":%d}\n", call, errno);
  }
  fflush(stdout);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s CALL...\n", argv[0]);
    return 1;
  }
  for (int i = 1; i < argc; i++) {
    errno = 0;
    if (strcmp(argv[i], "io_uring") == 0) report(argv[i], try_io_uring());
    else if (strcmp(argv[i], "vsock") == 0) report(argv[i], try_vsock());
    else if (strcmp(argv[i], "inet") == 0) report(argv[i], try_inet());
    else if (strcmp(argv[i], "file") == 0) report(argv[i], try_file());
    else {
      fprintf(stderr, "unknown call %s\n", argv[i]);
      return 1;
    }
  }
  return 0;
}
