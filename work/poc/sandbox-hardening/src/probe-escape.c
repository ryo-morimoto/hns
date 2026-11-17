/*
 * probe-escape: the C2 shapes. A path is tried against the Landlock ruleset
 * through each way a process could try to leave the root:
 *
 *   direct      - the path as given
 *   dotdot      - ROOT/../<name>, then open(2) resolves it
 *   symlink     - a symlink under ROOT that points outside
 *   bindmount   - an outside directory bind-mounted *inside* ROOT (bwrap did the mount)
 *   openbefore  - an fd opened before the ruleset was applied, read after
 *
 * Usage: probe-escape ROOT OUTER_FROM_PARENT OUTER_FROM_ESCAPE BIND_NAME
 *   OUTER_FROM_PARENT  a file next to ROOT (ROOT/../OUTER_FROM_PARENT), inside readable
 *   OUTER_FROM_ESCAPE  a file next to ROOT the symlink planted under ROOT points at
 *   BIND_NAME          the name under ROOT that bwrap bind-mounted an outside file on
 * Prints one JSON object per route (the field is called "route").
 *
 * Exit: 0 all shapes were tried (each may pass or be denied), 1 setup failed.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <linux/landlock.h>

#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif
#ifndef SYS_landlock_create_ruleset
#define SYS_landlock_create_ruleset 444
#endif
#ifndef SYS_landlock_add_rule
#define SYS_landlock_add_rule 445
#endif
#ifndef SYS_landlock_restrict_self
#define SYS_landlock_restrict_self 446
#endif

static int ll_create(const struct landlock_ruleset_attr *a, size_t s, __u32 f) {
  return (int)syscall(SYS_landlock_create_ruleset, a, s, f);
}
static int ll_add(int fd, enum landlock_rule_type t, const void *a, __u32 f) {
  return (int)syscall(SYS_landlock_add_rule, fd, t, a, f);
}
static int ll_restrict(int fd, __u32 f) { return (int)syscall(SYS_landlock_restrict_self, fd, f); }

static void report(const char *route, const char *path, int fd, int open_errno) {
  if (fd < 0) {
    printf("{\"route\":\"%s\",\"path\":\"%s\",\"ok\":false,\"errno\":%d}\n", route, path, open_errno);
    return;
  }
  char buf[1];
  errno = 0;
  ssize_t n = read(fd, buf, 1);
  if (n < 0) {
    printf("{\"route\":\"%s\",\"path\":\"%s\",\"ok\":false,\"errno\":%d}\n", route, path, errno);
  } else {
    printf("{\"route\":\"%s\",\"path\":\"%s\",\"ok\":true}\n", route, path);
  }
  close(fd);
  fflush(stdout);
}

/* Applies the same ruleset as probe-landlock. Returns 0 or prints a reason and returns 1. */
static int restrict_to(const char *root) {
  __u64 handled = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE |
                  LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR |
                  LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
                  LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
                  LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK |
                  LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |
                  LANDLOCK_ACCESS_FS_MAKE_SYM;
  int abi = ll_create(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) {
    fprintf(stderr, "landlock ABI probe failed: %s\n", strerror(errno));
    return 1;
  }
  if (abi >= 2) handled |= LANDLOCK_ACCESS_FS_REFER;
  if (abi >= 3) handled |= LANDLOCK_ACCESS_FS_TRUNCATE;
  if (abi >= 6) handled |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
  struct landlock_ruleset_attr attr = { .handled_access_fs = handled };
  int ruleset = ll_create(&attr, sizeof(attr), 0);
  if (ruleset < 0) {
    fprintf(stderr, "landlock_create_ruleset: %s\n", strerror(errno));
    return 1;
  }
  char partial[4096];
  size_t len = strlen(root);
  for (size_t i = 1; i <= len; i++) {
    if (i != len && root[i] != '/') continue;
    memcpy(partial, root, i);
    partial[i] = '\0';
    int fd = open(partial, O_PATH | O_CLOEXEC);
    if (fd < 0) {
      fprintf(stderr, "open(%s): %s\n", partial, strerror(errno));
      return 1;
    }
    struct landlock_path_beneath_attr beneath = {
      .allowed_access = (i == 1 ? LANDLOCK_ACCESS_FS_EXECUTE : 0) | LANDLOCK_ACCESS_FS_READ_DIR,
      .parent_fd = fd,
    };
    if (ll_add(ruleset, LANDLOCK_RULE_PATH_BENEATH, &beneath, 0) != 0) {
      fprintf(stderr, "landlock_add_rule(%s): %s\n", partial, strerror(errno));
      return 1;
    }
    close(fd);
  }
  int rootfd = open(root, O_PATH | O_CLOEXEC);
  if (rootfd < 0) {
    fprintf(stderr, "open(%s): %s\n", root, strerror(errno));
    return 1;
  }
  struct landlock_path_beneath_attr files = {
    .allowed_access = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE,
    .parent_fd = rootfd,
  };
  if (ll_add(ruleset, LANDLOCK_RULE_PATH_BENEATH, &files, 0) != 0) {
    fprintf(stderr, "landlock_add_rule(%s files): %s\n", root, strerror(errno));
    return 1;
  }
  close(rootfd);
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fprintf(stderr, "PR_SET_NO_NEW_PRIVS: %s\n", strerror(errno));
    return 1;
  }
  if (ll_restrict(ruleset, 0) != 0) {
    fprintf(stderr, "landlock_restrict_self: %s\n", strerror(errno));
    return 1;
  }
  close(ruleset);
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 5) {
    fprintf(stderr, "usage: %s ROOT OUTER_FROM_PARENT OUTER_FROM_ESCAPE BIND_NAME\n", argv[0]);
    return 1;
  }
  const char *root = argv[1];
  const char *outer = argv[2];
  const char *target = argv[3];
  const char *bound_name = argv[4];
  char inside[4096], dotdot[4096], via[4096], bound[4096];
  snprintf(inside, sizeof(inside), "%s/inside.txt", root);          /* inside: allowed */
  snprintf(dotdot, sizeof(dotdot), "%s/../%s", root, outer);        /* climbs out by .. */
  snprintf(via, sizeof(via), "%s/link-%s", root, target);           /* symlink planted by setup */
  snprintf(bound, sizeof(bound), "%s/%s", root, bound_name);        /* bind mount planted by setup */

  /* Opened before the ruleset, so the restriction cannot revoke it (fd inheritance). */
  int early = open(dotdot, O_RDONLY | O_CLOEXEC);
  int early_errno = errno;

  if (restrict_to(root) != 0) return 1;

  int fd;
  errno = 0;
  fd = open(inside, O_RDONLY | O_CLOEXEC);
  report("inside", inside, fd, errno);
  errno = 0;
  fd = open(dotdot, O_RDONLY | O_CLOEXEC);
  report("dotdot", dotdot, fd, errno);
  errno = 0;
  fd = open(via, O_RDONLY | O_CLOEXEC);
  report("symlink", via, fd, errno);
  errno = 0;
  fd = open(bound, O_RDONLY | O_CLOEXEC);
  report("bindmount", bound, fd, errno);
  report("openbefore", dotdot, early, early_errno);
  return 0;
}