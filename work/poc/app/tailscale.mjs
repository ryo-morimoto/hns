// Tailscale identity: whois a peer's tailnet address.
import { execFile } from "node:child_process";

export function parseUsers(text) {
  return String(text ?? "").split(",").map((name) => name.trim()).filter(Boolean);
}

export function isLoopback(address) {
  const ip = String(address ?? "");
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

const defaultWhois = (ip) => new Promise((resolve) => {
  execFile("tailscale", ["whois", "--json", ip], { timeout: 3000 }, (error, stdout) => {
    if (error) return resolve(undefined);
    try {
      const data = JSON.parse(stdout);
      resolve(data?.Node?.UserProfile?.LoginName ?? data?.UserProfile?.LoginName);
    } catch { resolve(undefined); }
  });
});

export function createTailscaleVerifier({ users = [], allowLocal = false, whois = defaultWhois, ttlMs = 60000 } = {}) {
  const cache = new Map();
  return async (remoteAddress) => {
    if (isLoopback(remoteAddress)) {
      return allowLocal ? { ok: true, user: "local" } : { ok: false, reason: "loopback is not trusted" };
    }
    const ip = String(remoteAddress ?? "").replace(/^::ffff:/, "");
    const hit = cache.get(ip);
    const now = Date.now();
    let login;
    if (hit && now - hit.at < ttlMs) login = hit.login;
    else { login = await whois(ip); cache.set(ip, { at: now, login }); }

    if (!login) return { ok: false, reason: "unknown tailnet node" };
    if (users.length > 0 && !users.includes(login)) return { ok: false, reason: "user is not allowed" };
    return { ok: true, user: login };
  };
}
