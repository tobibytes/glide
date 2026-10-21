import { useEffect, useState } from "react";
import { parseRoute, settingsHash, type Route } from "../lib/route";
import { glide } from "../lib/glide";

/** Route from location.hash, kept in sync with hashchange and evt:navigate. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onHash);
    const off = glide().onNavigate((r) => {
      const next = parseRoute(r);
      if (next.mode === "settings") {
        const hash = settingsHash(next.page, next.id, next.anchor);
        if (location.hash !== hash) location.hash = hash;
        else setRoute(next);
      }
    });
    return () => {
      window.removeEventListener("hashchange", onHash);
      off();
    };
  }, []);
  return route;
}
