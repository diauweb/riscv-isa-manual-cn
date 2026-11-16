import { useCallback, useEffect, useState } from "react";
import type { VolumeId } from "../types";

/**
 * Hash-based routes, so every view is shareable and works on GitHub Pages
 * without an SPA fallback:
 *
 *   #/                                   home (book overview)
 *   #/<volume>/<chapter>                 read a chapter
 *
 * Optional query parameters (after `?` inside the hash):
 *   v    snapshot ref (ratified tag or SHA prefix); omitted = site default
 *   cmp  base snapshot ref; present = compare mode (`v` is the target)
 *   at   anchor / section id / `u-<unit id prefix>` to scroll to
 */
export type Page = "home" | "chapter";

export interface Route {
  page: Page;
  volume?: VolumeId;
  chapter?: string;
  v?: string;
  cmp?: string;
  at?: string;
}

const VOLUMES: VolumeId[] = ["unpriv", "priv", "profiles", "debug"];

function enc(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ":");
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const qIdx = raw.indexOf("?");
  const path = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  const query = new URLSearchParams(qIdx >= 0 ? raw.slice(qIdx + 1) : "");
  const segs = path
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });

  const common = {
    v: query.get("v") || undefined,
    cmp: query.get("cmp") || undefined,
    at: query.get("at") || undefined,
  };

  if (segs.length >= 1 && VOLUMES.includes(segs[0] as VolumeId)) {
    return {
      page: "chapter",
      volume: segs[0] as VolumeId,
      chapter: segs[1],
      ...common,
    };
  }
  return { page: "home", ...common };
}

export function formatHash(route: Route): string {
  let path = "/";
  if (route.page === "chapter" && route.volume) {
    path = `/${route.volume}${route.chapter ? `/${enc(route.chapter)}` : ""}`;
  }
  const q = new URLSearchParams();
  if (route.v) q.set("v", route.v);
  if (route.page === "chapter" && route.cmp) q.set("cmp", route.cmp);
  if (route.at) q.set("at", route.at);
  const qs = q.toString().replace(/%3A/gi, ":");
  return `#${path}${qs ? `?${qs}` : ""}`;
}

export interface NavigateOptions {
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
}

/**
 * Current route plus `navKey`, which increments on every *navigation* (link
 * click, back/forward, push) but not on silent `replace` updates. Scroll
 * restoration keys off `navKey` so syncing the URL while reading never jumps.
 */
export function useHashRoute() {
  const [route, setRoute] = useState<Route>(() =>
    parseHash(window.location.hash),
  );
  const [navKey, setNavKey] = useState(0);

  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash(window.location.hash));
      setNavKey((k) => k + 1);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = useCallback((next: Route, opts: NavigateOptions = {}) => {
    const hash = formatHash(next);
    if (opts.replace) {
      if (hash !== window.location.hash) {
        window.history.replaceState(window.history.state, "", hash);
      }
      setRoute(parseHash(hash));
      return;
    }
    if (hash === window.location.hash) {
      setRoute(parseHash(hash));
      setNavKey((k) => k + 1);
    } else {
      window.location.hash = hash;
    }
  }, []);

  return { route, navKey, navigate };
}

export function absoluteUrl(route: Route): string {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}${formatHash(route)}`;
}
