import { useEffect, useState } from "react";

/** Track which section heading the reader is currently in. */
export function useScrollSpy(ids: string[], enabledKey: unknown): string | null {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    if (ids.length === 0) {
      setActive(null);
      return;
    }
    let frame = 0;
    const compute = () => {
      frame = 0;
      const header = document.getElementById("site-header");
      const line = (header?.offsetHeight ?? 56) + 96;
      let current: string | null = null;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= line) current = id;
        else break;
      }
      // At the very bottom, highlight the last section.
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) {
        for (let i = ids.length - 1; i >= 0; i--) {
          if (document.getElementById(ids[i])) {
            current = ids[i];
            break;
          }
        }
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(compute);
    };
    compute();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ids, enabledKey]);

  return active;
}

/** 0..1 scroll progress through the page. */
export function useScrollProgress(): number {
  const [p, setP] = useState(0);
  useEffect(() => {
    let frame = 0;
    const compute = () => {
      frame = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setP(max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(compute);
    };
    compute();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return p;
}

let activeScrollLocks = 0;
let savedOverflow = "";

/** Lock document body scrolling while a mobile drawer, sheet, or modal is open. */
export function useBodyScrollLock(locked: boolean): void {
  useEffect(() => {
    if (!locked) return;
    if (activeScrollLocks === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    activeScrollLocks += 1;
    return () => {
      activeScrollLocks = Math.max(0, activeScrollLocks - 1);
      if (activeScrollLocks === 0) {
        document.body.style.overflow = savedOverflow;
      }
    };
  }, [locked]);
}

/** Reactive CSS media query hook. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
