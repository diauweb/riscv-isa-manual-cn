import type { AnchorIndex, VolumeId } from "../types";
import { fetchAnchorIndex } from "../utils/dataClient";

export interface AnchorTarget {
  volume: VolumeId;
  chapter: string;
  sectionId?: string;
  anchorId: string;
}

const anchorMapCache: Partial<Record<"demo" | "live", Promise<Map<string, AnchorTarget>>>> = {};

function buildMap(index: AnchorIndex): Map<string, AnchorTarget> {
  const map = new Map<string, AnchorTarget>();
  for (const [id, entry] of Object.entries(index.anchors)) {
    const target: AnchorTarget = {
      volume: entry.volume_id,
      chapter: entry.chapter_id,
      sectionId: entry.section_id,
      anchorId: entry.anchor_id,
    };
    if (!map.has(id)) map.set(id, target);
    if (entry.anchor_id && !map.has(entry.anchor_id)) {
      map.set(entry.anchor_id, target);
    }
    if (entry.section_id && !map.has(entry.section_id)) {
      map.set(entry.section_id, target);
    }
  }
  return map;
}

/** Resolve a cross-reference id to the chapter that defines it (lazy, cached). */
export async function lookupAnchor(
  id: string,
  demoMode: boolean,
): Promise<AnchorTarget | null> {
  const key = demoMode ? "demo" : "live";
  let pending = anchorMapCache[key];
  if (!pending) {
    pending = fetchAnchorIndex(demoMode)
      .then(buildMap)
      .catch((err) => {
        delete anchorMapCache[key];
        throw err;
      });
    anchorMapCache[key] = pending;
  }
  const map = await pending;
  return map.get(id) ?? null;
}

/** Find the element for an `at` value inside the current page. */
export function findAnchorElement(at: string): HTMLElement | null {
  if (at.startsWith("u-")) {
    const prefix = at.slice(2).replace(/[^0-9a-f]/gi, "");
    if (!prefix) return null;
    return document.querySelector<HTMLElement>(
      `[data-unit-id^="${prefix}"]`,
    );
  }
  const byId = document.getElementById(at);
  if (byId) return byId;
  try {
    return document.querySelector<HTMLElement>(
      `[data-anchor="${CSS.escape(at)}"]`,
    );
  } catch {
    return null;
  }
}

/** Scroll so the element sits just below the sticky header. */
export function scrollToElement(el: HTMLElement, smooth = true) {
  const header = document.getElementById("site-header");
  const offset = (header?.offsetHeight ?? 56) + 20;
  const top = el.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
}

export function flashElement(el: HTMLElement) {
  el.classList.remove("doc-flash");
  // force reflow so the animation restarts
  void el.offsetWidth;
  el.classList.add("doc-flash");
  window.setTimeout(() => el.classList.remove("doc-flash"), 2200);
}
