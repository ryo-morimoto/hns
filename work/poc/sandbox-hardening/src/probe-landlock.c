/*
 * probe-landlock: apply a Landlock ruleset to this process, then try paths.
 *
 * Runs inside bwrap, after its mount namespace is built. The ruleset is the
 * "read only under one root" shape hns would need if Landlock became the second
 * fence: every handled access is denied unless the path is under the root.
 *
 * Usage: probe-landlock ROOT [PATH...]
 * Prints one JSON object per path on stdout: {"path": ..., "ok": true|false, "errno": N}
 * The ruleset version (the ABI) is printed first as {"abi": N}.
 *
 * Exit: 0 ruleset applied (paths may still be denied), 2 ABI below 3,
 * 1 anything else. A probe that cannot run is never reported as working.
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

static int landlock_create_ruleset(const struct landlock_ruleset_attr *attr, size_t size, __u32 flags) {
  return (int)syscall(SYS_landlock_create_ruleset, attr, size, flags);
}
static int landlock_add_rule(int fd, enum landlock_rule_type type, const void *attr, __u32 flags) {
  return (int)syscall(SYS_landlock_add_rule, fd, type, attr, flags);
}
static int landlock_restrict_self(int fd, __u32 flags) {
  return (int)syscall(SYS_landlock_restrict_self, fd, flags);
}

/* The read-side accesses: what a shell needs to read a file and walk to it. */
static __u64 file_read_accesses(void) { return LANDLOCK_ACCESS_FS_READ_FILE; }
static __u64 dir_read_accesses(void) { return LANDLOCK_ACCESS_FS_READ_DIR; }

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s ROOT [PATH...]\n", argv[0]);
    return 1;
  }
  int abi = landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) {
    fprintf(stderr, "landlock_create_ruleset(VERSION) failed: %s\n", strerror(errno));
    return 1;
  }
  printf("{\"abi\":%d}\n", abi);
  if (abi < 3) {
    fprintf(stderr, "landlock ABI %d is below 3: no TRUNCATE/REFER, the probe needs v3+\n", abi);
    return 2;
  }

  __u64 handled = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE |
                  LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR |
                  LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
                  LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
                  LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK |
                  LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |
                  LANDLOCK_ACCESS_FS_MAKE_SYM;
  if (abi >= 2) handled |= LANDLOCK_ACCESS_FS_REFER;
  if (abi >= 3) handled |= LANDLOCK_ACCESS_FS_TRUNCATE;
  if (abi >= 6) handled |= LANDLOCK_ACCESS_FS_IOCTL_DEV;

  struct landlock_ruleset_attr ruleset_attr = { .handled_access_fs = handled };
  int ruleset = landlock_create_ruleset(&ruleset_attr, sizeof(ruleset_attr), 0);
  if (ruleset < 0) {
    fprintf(stderr, "landlock_create_ruleset failed: %s\n", strerror(errno));
    return 1;
  }

  /* Every path component from / down to the root must grant READ_DIR for traversal. */
  const char *root = argv[1];
  char partial[4096];
  size_t len = strlen(root);
  if (len >= sizeof(partial) || root[0] != '/') {
    fprintf(stderr, "root must be an absolute path under 4096 bytes\n");
    return 1;
  }
  for (size_t i = 1; i <= len; i++) {
    if (i != len && root[i] != '/') continue;
    memcpy(partial, root, i);
    partial[i] = '\0';
    int fd = open(partial, O_PATH | O_CLOEXEC);
    if (fd < 0) {
      fprintf(stderr, "open(%s) failed: %s\n", partial, strerror(errno));
      return 1;
    }
    int is_root = i == 1;
    struct landlock_path_beneath_attr beneath = {
      .allowed_access = (is_root ? LANDLOCK_ACCESS_FS_EXECUTE : 0) | dir_read_accesses(),
      .parent_fd = fd,
    };
    if (landlock_add_rule(ruleset, LANDLOCK_RULE_PATH_BENEATH, &beneath, 0) != 0) {
      fprintf(stderr, "landlock_add_rule(%s) failed: %s\n", partial, strerror(errno));
      return 1;
    }
    close(fd);
  }

  /* Files under the root are readable; the rule is per inode, so it rides a bind mount of it. */
  int rootfd = open(root, O_PATH | O_CLOEXEC);
  if (rootfd < 0) {
    fprintf(stderr, "open(%s) failed: %s\n", root, strerror(errno));
    return 1;
  }
  struct landlock_path_beneath_attr files = {
    .allowed_access = file_read_accesses() | LANDLOCK_ACCESS_FS_WRITE_FILE,
    .parent_fd = rootfd,
  };
  if (landlock_add_rule(ruleset, LANDLOCK_RULE_PATH_BENEATH, &files, 0) != 0) {
    fprintf(stderr, "landlock_add_rule(files) failed: %s\n", strerror(errno));
    return 1;
  }
  close(rootfd);

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fprintf(stderr, "PR_SET_NO_NEW_PRIVS failed: %s\n", strerror(errno));
    return 1;
  }
  if (landlock_restrict_self(ruleset, 0) != 0) {
    fprintf(stderr, "landlock_restrict_self failed: %s\n", strerror(errno));
    return 1;
  }
  close(ruleset);

  for (int i = 2; i < argc; i++) {
    errno = 0;
    int fd = open(argv[i], O_RDONLY | O_CLOEXEC);
    if (fd >= 0) {
      char buf[1];
      ssize_t n = read(fd, buf, 1);
      close(fd);
      if (n < 0) {
        printf("{\"path\":\"%s\",\"ok\":false,\"errno\":%d}\n", argv[i], errno);
      } else {
        printf("{\"path\":\"%s\",\"ok\":true}\n", argv[i]);
      }
    } else {
      printf("{\"path\":\"%s\",\"ok\":false,\"errno\":%d}\n", argv[i], errno);
    }
    fflush(stdout);
  }
  return 0;
}
