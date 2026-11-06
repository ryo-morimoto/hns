// SandboxEnv: an ExecutionEnv whose exec() runs inside bubblewrap with only the root writable.
export function createSandboxEnv(env, { root, bwrap = "bwrap" }) {
  const prefix = root.endsWith("/") ? root : root + "/";
  const under = (path) => path === root || path.startsWith(prefix);

  const wrap = (command, options) => {
    const cwd = under(options?.cwd ?? env.cwd) ? (options?.cwd ?? env.cwd) : root;
    const args = ["--die-with-parent", "--ro-bind", "/", "/", "--bind", root, root, "--dev", "/dev", "--proc", "/proc"];
    // A tmpfs at /tmp would hide a root that lives there, so leave /tmp read-only in that case.
    if (!root.startsWith("/tmp/")) args.push("--tmpfs", "/tmp");
    args.push("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--chdir", cwd, "--");
    const argv = typeof command === "string" ? [...args, "/bin/sh", "-c", command] : [...args, ...command];
    return [bwrap, ...argv];
  };

  return new Proxy(env, {
    get(target, property) {
      if (property === "exec") {
        return (command, options, context) => target.exec(wrap(command, options), options, context);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
