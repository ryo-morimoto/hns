/** The path the login screen occupies (0108). */
export const LOGIN_PATH = "/login";

/** The parts of a location the redirect reads. */
export interface LocationLike {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

/** Control characters are never part of a local path. */
function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The local path to return to after login.
 *
 * @param search - A location search string, normally `window.location.search`.
 * @returns The `next` value when it is a local path; null when it is missing or unsafe.
 *
 * @remarks
 * The login screen (0108) reads this after the passkey succeeds. Only a same-origin path is
 * accepted: an absolute URL, a protocol-relative path, a backslash, or a control character is
 * dropped so the redirect cannot leave the application.
 */
export function nextPathFrom(search: string): string | null {
  const next = new URLSearchParams(search).get("next");
  if (next === null) return null;
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  if (next.includes("\\") || hasControl(next)) return null;
  if (
    next === LOGIN_PATH ||
    next.startsWith(LOGIN_PATH + "?") ||
    next.startsWith(LOGIN_PATH + "#")
  ) {
    return null;
  }
  return next;
}

/**
 * The login URL that remembers the current location.
 *
 * @param location - The browser location.
 * @returns `/login?next=<encoded location>`, or null when already on the login path.
 *
 * @remarks
 * The hash route carries the deep link, so the whole path, query, and hash are kept. A client
 * that is already on `/login` gets null, which stops a 401 loop before the login screen lands.
 */
export function loginHref(location: LocationLike): string | null {
  if (location.pathname === LOGIN_PATH) return null;
  const deepLink = location.pathname + location.search + location.hash;
  return LOGIN_PATH + "?next=" + encodeURIComponent(deepLink);
}

/**
 * Navigate to the login screen, preserving the deep link.
 *
 * @param location - The browser location.
 * @param assign - The navigation side effect; tests pass a spy.
 */
export function redirectToLogin(location: LocationLike, assign: (href: string) => void): void {
  const href = loginHref(location);
  if (href !== null) assign(href);
}
