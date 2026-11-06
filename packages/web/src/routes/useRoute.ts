import { useEffect, useState } from "react";
import { formatHash, parseHash, type Route } from "./route.ts";

/** The current hash route. Unknown hashes are rewritten to their canonical workspace form. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));

  useEffect(() => {
    const normalize = (): void => {
      const parsed = parseHash(window.location.hash);
      const canonical = formatHash(parsed);
      if (window.location.hash !== canonical) history.replaceState(null, "", canonical);
      setRoute(parsed);
    };
    normalize();
    const onHashChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return route;
}

export function navigate(route: Route): void {
  window.location.hash = formatHash(route);
}

/** Replace without a back entry (used for defaults such as the first project). */
export function replaceRoute(route: Route): void {
  history.replaceState(null, "", formatHash(route));
  window.dispatchEvent(new Event("hashchange"));
}
