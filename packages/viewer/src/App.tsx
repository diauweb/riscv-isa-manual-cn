import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type {
  ResolvedChapter,
  SearchEntry,
  SiteChapterEntry,
  SiteIndex,
  SiteSnapshot,
  SiteVolume,
  VolumeId,
} from "./types";
import {
  DataNotFoundError,
  fetchResolvedChapter,
  fetchSiteIndex,
  fetchSiteTree,
  fetchUnitMetaShard,
  getDemoSiteIndex,
  siteDataVersion,
} from "./utils/dataClient";
import { buildCompareRows } from "./utils/diff";
import { absoluteUrl, formatHash, parseHash, useHashRoute, type Route } from "./lib/route";
import { useReaderSettings, type ReaderSettings } from "./lib/settings";
import {
  cleanChapterTitle,
  findChapter,
  parentSnapshot,
  resolveSnapshot,
  snapshotLabel,
  snapshotRef,
} from "./lib/snapshots";
import {
  findAnchorElement,
  flashElement,
  lookupAnchor,
  scrollToElement,
} from "./lib/anchors";
import { searchEntryAt } from "./lib/search";
import { useScrollSpy } from "./lib/scroll";
import { TopBar, type CompareBarModel } from "./components/TopBar";
import { BookNav, PageToc, tocSections } from "./components/Navigation";
import { ChapterPage, type CompareState } from "./components/ChapterPage";
import { HomePage } from "./components/HomePage";
import { SearchDialog } from "./components/SearchDialog";
import { Inspector } from "./components/Inspector";
import { SetupWelcome } from "./components/SetupWelcome";
import { Kbd, Spinner, cx } from "./components/ui";

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

function useSiteTree(
  treeHash: string | undefined,
  index: SiteIndex | null,
  demoMode: boolean,
  recoverStaleIndex: () => Promise<boolean>,
  recoveryEpoch: number,
): { volumes: SiteVolume[]; loading: boolean; error: string | null } {
  const isDefault = Boolean(index && treeHash && treeHash === index.default_tree_hash);
  const [state, setState] = useState<{
    hash?: string;
    volumes: SiteVolume[];
    loading: boolean;
    error: string | null;
  }>({ volumes: [], loading: false, error: null });

  useEffect(() => {
    if (!treeHash || isDefault) {
      setState({ hash: treeHash, volumes: [], loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, hash: treeHash, loading: true, error: null }));
    fetchSiteTree(treeHash, index, demoMode)
      .then(
        (tree) =>
          !cancelled &&
          setState({ hash: treeHash, volumes: tree.volumes, loading: false, error: null }),
      )
      .catch(async (err) => {
        if (cancelled) return;
        if (!demoMode && err instanceof DataNotFoundError) {
          const recovered = await recoverStaleIndex();
          if (cancelled || recovered) return;
        }
        setState({
          hash: treeHash,
          volumes: [],
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [treeHash, isDefault, index, demoMode, recoverStaleIndex, recoveryEpoch]);

  if (isDefault && index) {
    return { volumes: index.default_volumes, loading: false, error: null };
  }
  const fresh = state.hash === treeHash;
  return {
    volumes: fresh ? state.volumes : [],
    loading: Boolean(treeHash) && (!fresh || state.loading),
    error: fresh ? state.error : null,
  };
}

function useResolvedChapter(
  entry: SiteChapterEntry | undefined,
  demoMode: boolean,
  recoverStaleIndex: () => Promise<boolean>,
  recoveryEpoch: number,
) {
  const key = entry ? `${entry.struct_hash}:${entry.pack_hash}` : undefined;
  const [state, setState] = useState<{
    key?: string;
    bundle: ResolvedChapter | null;
    loading: boolean;
    error: string | null;
  }>({ bundle: null, loading: false, error: null });

  useEffect(() => {
    if (!entry || !key) {
      setState({ bundle: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, key, loading: true, error: null }));
    fetchResolvedChapter(entry, demoMode)
      .then((bundle) => !cancelled && setState({ key, bundle, loading: false, error: null }))
      .catch(async (err) => {
        if (cancelled) return;
        if (!demoMode && err instanceof DataNotFoundError) {
          const recovered = await recoverStaleIndex();
          if (cancelled || recovered) return;
        }
        setState({
          key,
          bundle: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [entry, key, demoMode, recoverStaleIndex, recoveryEpoch]);

  // Never hand out a stale chapter for a different structure/pack key.
  const fresh = state.key === key;
  return {
    bundle: fresh ? state.bundle : null,
    loading: Boolean(key) && (!fresh || state.loading),
    error: fresh ? state.error : null,
  };
}

function useCompareLineage(
  comparing: boolean,
  baseBundle: ResolvedChapter | null,
  targetBundle: ResolvedChapter | null,
  demoMode: boolean,
  dataVersion: string,
): Map<string, string> | undefined {
  const lineageKey =
    comparing && baseBundle && targetBundle
      ? `${dataVersion}:${baseBundle.struct_hash}:${baseBundle.pack_hash}:${targetBundle.struct_hash}:${targetBundle.pack_hash}`
      : undefined;
  const [state, setState] = useState<{ key?: string; map?: Map<string, string> }>({});

  useEffect(() => {
    if (!lineageKey || !baseBundle || !targetBundle) {
      setState({});
      return;
    }
    const prefixes = new Set<string>();
    for (const uid of Object.keys(targetBundle.units)) {
      if (!baseBundle.units[uid]) prefixes.add(uid.slice(0, 2));
    }
    for (const uid of Object.keys(baseBundle.units)) {
      if (!targetBundle.units[uid]) prefixes.add(uid.slice(0, 2));
    }
    if (prefixes.size === 0) {
      setState({ key: lineageKey, map: undefined });
      return;
    }
    let cancelled = false;
    Promise.all([...prefixes].map((p) => fetchUnitMetaShard(p, demoMode).catch(() => null)))
      .then((shards) => {
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const shard of shards) {
          if (!shard) continue;
          for (const meta of Object.values(shard)) {
            if (meta.prev_unit_id && meta.prev_unit_id !== meta.unit_id) {
              map.set(meta.unit_id, meta.prev_unit_id);
            }
            for (const h of meta.upstream_history) {
              if (h.prev_unit_id && h.prev_unit_id !== h.unit_id) {
                map.set(h.unit_id, h.prev_unit_id);
              }
            }
          }
        }
        setState({ key: lineageKey, map });
      })
      .catch(() => {
        if (!cancelled) setState({ key: lineageKey, map: undefined });
      });
    return () => {
      cancelled = true;
    };
  }, [lineageKey, baseBundle, targetBundle, demoMode]);

  return state.key === lineageKey ? state.map : undefined;
}

function findSnapshotStrict(index: SiteIndex, ref: string | undefined): SiteSnapshot | undefined {
  if (!ref) return undefined;
  return (
    index.snapshots.find((s) => s.ratified_tag === ref) ??
    index.snapshots.find((s) => s.sha.startsWith(ref.toLowerCase()))
  );
}

/** First visible block, so layout changes can keep the reader's place. */
function captureReadingPosition(): { id: string; top: number } | null {
  const header = document.getElementById("site-header")?.offsetHeight ?? 56;
  for (const el of document.querySelectorAll<HTMLElement>(".doc-block")) {
    const r = el.getBoundingClientRect();
    if (r.bottom > header + 8) return { id: el.id, top: r.top };
  }
  return null;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export const App: React.FC = () => {
  const [index, setIndex] = useState<SiteIndex | null>(null);
  const [indexLoading, setIndexLoading] = useState(true);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [recoveryEpoch, setRecoveryEpoch] = useState(0);
  const indexRef = useRef<SiteIndex | null>(null);
  indexRef.current = index;
  const recoveryInFlight = useRef<Promise<boolean> | null>(null);
  const lastRecoveryAt = useRef(0);

  const dataVersion = useMemo(
    () => (demoMode ? "demo" : index ? siteDataVersion(index) : ""),
    [demoMode, index],
  );

  // If a long-lived tab hits a 404 on a replaced chapter pack/structure/tree after a new
  // Pages deploy, bypass browser & edge caches to refresh `index.json` transparently.
  const recoverStaleIndex = useCallback((): Promise<boolean> => {
    if (demoMode) return Promise.resolve(false);
    if (recoveryInFlight.current) return recoveryInFlight.current;
    const now = Date.now();
    if (now - lastRecoveryAt.current < 5_000) {
      return Promise.resolve(false);
    }
    lastRecoveryAt.current = now;
    const prevVersion = indexRef.current ? siteDataVersion(indexRef.current) : null;
    const task = fetchSiteIndex({ bustCache: true })
      .then((fresh) => {
        const nextVersion = siteDataVersion(fresh);
        if (nextVersion !== prevVersion) {
          indexRef.current = fresh;
          setIndex(fresh);
          setRecoveryEpoch((n) => n + 1);
          return true;
        }
        return false;
      })
      .catch(() => false)
      .finally(() => {
        recoveryInFlight.current = null;
      });
    recoveryInFlight.current = task;
    return task;
  }, [demoMode]);

  const { route, navKey, navigate } = useHashRoute();
  const { settings, update } = useReaderSettings();

  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [inspectedUnitId, setInspectedUnitId] = useState<string | null>(null);
  const [changesOnly, setChangesOnly] = useState(true);
  const [activeChangeIdx, setActiveChangeIdx] = useState(-1);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1800);
  }, []);

  // ------------------------------------------------------------ index load
  useEffect(() => {
    let cancelled = false;
    fetchSiteIndex()
      .then((idx) => {
        if (!cancelled) setIndex(idx);
      })
      .catch((err) => {
        if (cancelled) return;
        setIndexError(
          err instanceof DataNotFoundError || err instanceof Error ? err.message : String(err),
        );
      })
      .finally(() => !cancelled && setIndexLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // ------------------------------------------------------ route resolution
  const snapshot = useMemo(
    () => (index ? resolveSnapshot(index, route.v) : undefined),
    [index, route.v],
  );
  const baseSnapshot = useMemo(
    () => (index && route.page === "chapter" ? findSnapshotStrict(index, route.cmp) : undefined),
    [index, route.page, route.cmp],
  );
  const comparing = Boolean(baseSnapshot && snapshot);

  const targetTree = useSiteTree(
    snapshot?.tree_hash,
    index,
    demoMode,
    recoverStaleIndex,
    recoveryEpoch,
  );
  const baseTree = useSiteTree(
    comparing ? baseSnapshot?.tree_hash : undefined,
    index,
    demoMode,
    recoverStaleIndex,
    recoveryEpoch,
  );

  const volumes = useMemo(
    () => targetTree.volumes.filter((v) => v.chapters.length > 0),
    [targetTree.volumes],
  );
  const activeVolume =
    volumes.find((v) => v.id === route.volume) ?? (route.page === "chapter" ? undefined : volumes[0]);
  const activeVolumeChapters = useMemo(() => activeVolume?.chapters ?? [], [activeVolume]);

  // `#/<volume>` without a chapter → first chapter of that volume.
  useEffect(() => {
    if (route.page === "chapter" && route.volume && !route.chapter && activeVolumeChapters[0]) {
      navigate({ ...route, chapter: activeVolumeChapters[0].id }, { replace: true });
    }
  }, [route, activeVolumeChapters, navigate]);

  const chapter = findChapter(targetTree.volumes, route.volume, route.chapter);
  const baseChapter = comparing ? findChapter(baseTree.volumes, route.volume, route.chapter) : undefined;
  const chapterMeta = chapter ?? baseChapter;

  const target = useResolvedChapter(
    route.page === "chapter" ? chapter : undefined,
    demoMode,
    recoverStaleIndex,
    recoveryEpoch,
  );
  const base = useResolvedChapter(
    comparing ? baseChapter : undefined,
    demoMode,
    recoverStaleIndex,
    recoveryEpoch,
  );
  const lineageMap = useCompareLineage(
    comparing,
    base.bundle,
    target.bundle,
    demoMode,
    dataVersion,
  );

  const rows = useMemo(
    () =>
      comparing && !target.loading && !base.loading
        ? buildCompareRows(base.bundle, target.bundle, lineageMap)
        : [],
    [comparing, target.loading, base.loading, base.bundle, target.bundle, lineageMap],
  );
  const changeRows = useMemo(() => rows.filter((r) => r.changeKind !== "unchanged"), [rows]);
  const stats = useMemo(() => {
    const s = { added: 0, modified: 0, moved: 0, deleted: 0 };
    for (const r of changeRows) s[r.changeKind as keyof typeof s] += 1;
    return s;
  }, [changeRows]);

  useEffect(() => setActiveChangeIdx(-1), [rows]);

  const contentLoading =
    targetTree.loading || (comparing && baseTree.loading) || target.loading || base.loading;
  const headBundle = target.bundle ?? base.bundle;

  // ------------------------------------------------------- link builders
  const { volume: rVolume, chapter: rChapter, v: rV, cmp: rCmp } = route;
  const makePermalink = useCallback(
    (at: string) =>
      formatHash({ page: "chapter", volume: rVolume, chapter: rChapter, v: rV, cmp: rCmp, at }),
    [rVolume, rChapter, rV, rCmp],
  );
  const chapterHref = useCallback(
    (volume: VolumeId, chapterId: string) =>
      formatHash({ page: "chapter", volume, chapter: chapterId, v: rV }),
    [rV],
  );
  const homeHref = formatHash({ page: "home", v: rV });

  // -------------------------------------------------------------- TOC/spy
  const sections = useMemo(() => tocSections(headBundle, settings.lang), [headBundle, settings.lang]);
  const sectionIds = useMemo(() => sections.map((s) => s.id), [sections]);
  const activeSectionId = useScrollSpy(
    route.page === "chapter" && !contentLoading ? sectionIds : [],
    `${changesOnly}:${settings.lang}:${settings.fontSize}`,
  );

  // ------------------------------------------- scroll on real navigation
  const handledNav = useRef(-1);
  const lastPageKey = useRef("");
  const lastProgrammaticScroll = useRef(0);

  useEffect(() => {
    if (!index || contentLoading) return;
    if (handledNav.current === navKey) return;
    handledNav.current = navKey;
    const pageKey = `${route.page}/${route.volume}/${route.chapter}/${route.v}/${route.cmp}`;
    const samePage = pageKey === lastPageKey.current;
    lastPageKey.current = pageKey;
    lastProgrammaticScroll.current = Date.now();

    requestAnimationFrame(() => {
      if (route.at) {
        const el = findAnchorElement(route.at);
        if (el) {
          scrollToElement(el, samePage);
          const block = el.closest<HTMLElement>(".doc-block") ?? el;
          if (block.dataset.kind !== "heading") flashElement(block);
          return;
        }
      }
      if (!samePage) {
        window.scrollTo({ top: 0 });
      } else if (!route.at) {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  }, [index, navKey, contentLoading, route]);

  // Keep `at` in the URL in sync with the section being read (no history noise).
  useEffect(() => {
    if (route.page !== "chapter" || contentLoading) return;
    if (Date.now() - lastProgrammaticScroll.current < 1200) return;
    const at = activeSectionId ?? undefined;
    if (at === route.at) return;
    navigate({ ...route, at }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSectionId]);

  // ------------------------------------------------------ settings + place
  const updateSetting = useCallback(
    <K extends keyof ReaderSettings>(key: K, value: ReaderSettings[K]) => {
      const keepPlace = key === "lang" || key === "fontSize";
      const pos = keepPlace ? captureReadingPosition() : null;
      update(key, value);
      if (pos) {
        lastProgrammaticScroll.current = Date.now();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const el = document.getElementById(pos.id);
            if (el) window.scrollBy({ top: el.getBoundingClientRect().top - pos.top });
          }),
        );
      }
    },
    [update],
  );

  // ----------------------------------------------------------- navigation
  const go = useCallback((r: Route) => navigate(r), [navigate]);

  // Route all in-app `#/…` links through the router (same-hash clicks still scroll),
  // resolve AsciiDoc cross-references (`#anchor`, `file.html#anchor`) and open external links in a new tab.
  useEffect(() => {
    const resolveAndNavigateAnchor = async (id: string, fallbackChapterStem?: string) => {
      if (id) {
        if (id.startsWith("fn-") || id.startsWith("_footnote")) {
          const el = findAnchorElement(id);
          if (el) {
            scrollToElement(el, true);
            return;
          }
        }
        if (findAnchorElement(id)) {
          go({ ...route, at: id });
          return;
        }
        try {
          const t = await lookupAnchor(id, demoMode);
          if (t) {
            go({ page: "chapter", volume: t.volume, chapter: t.chapter, v: route.v, at: t.anchorId || id });
            return;
          }
        } catch {
          // fall through to fallbackChapterStem or toast
        }
      }
      if (fallbackChapterStem) {
        const stem = fallbackChapterStem.toLowerCase();
        for (const vol of volumes) {
          const hit = vol.chapters.find(
            (c) =>
              c.id.toLowerCase() === stem ||
              c.id.toLowerCase().endsWith(`/${stem}`) ||
              c.id.toLowerCase().endsWith(`-${stem}`),
          );
          if (hit) {
            go({ page: "chapter", volume: vol.id, chapter: hit.id, v: route.v, at: id || undefined });
            return;
          }
        }
      }
      showToast("未找到引用的位置");
    };

    const onClick = async (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!href) return;
      if (href.startsWith("#/") || href === "#") {
        e.preventDefault();
        go(parseHash(href));
        return;
      }
      if (href.startsWith("#")) {
        e.preventDefault();
        let id = href.slice(1);
        try {
          id = decodeURIComponent(id);
        } catch {
          // keep raw
        }
        const citeKey = a.getAttribute("data-cite-key");
        if (citeKey) {
          const targetId = findAnchorElement(id)
            ? id
            : findAnchorElement(citeKey)
              ? citeKey
              : null;
          if (targetId) {
            go({ ...route, at: targetId });
            return;
          }
          const cross =
            (await lookupAnchor(id, demoMode).catch(() => null)) ??
            (await lookupAnchor(citeKey, demoMode).catch(() => null));
          if (cross) {
            go({ page: "chapter", volume: cross.volume, chapter: cross.chapter, v: route.v, at: cross.anchorId || citeKey });
            return;
          }
          const citeText = a.getAttribute("data-cite-text");
          showToast(citeText ? `参考文献：${citeText}` : `参考文献：${citeKey}`);
          return;
        }
        await resolveAndNavigateAnchor(id);
        return;
      }
      if (/^https?:\/\//.test(href)) {
        if (a.closest(".doc-prose")) {
          a.target = "_blank";
          a.rel = "noreferrer";
        }
        return;
      }
      const xrefMatch = /^([^?#]+?)\.html(?:#(.*))?$/i.exec(href);
      if (xrefMatch && a.closest(".doc-prose")) {
        e.preventDefault();
        const fileStem = xrefMatch[1].split("/").pop() ?? "";
        let id = xrefMatch[2] ?? "";
        try {
          id = decodeURIComponent(id);
        } catch {
          // keep raw
        }
        await resolveAndNavigateAnchor(id, fileStem);
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [go, route, volumes, demoMode, showToast]);

  const scrollToChange = useCallback(
    (idx: number) => {
      const row = changeRows[idx];
      if (!row) return;
      setActiveChangeIdx(idx);
      const el = document.getElementById(`row-${row.rowKey}`);
      if (el) {
        lastProgrammaticScroll.current = Date.now();
        const header = document.getElementById("site-header")?.offsetHeight ?? 56;
        const top = el.getBoundingClientRect().top + window.scrollY - header - window.innerHeight * 0.18;
        window.scrollTo({ top, behavior: "smooth" });
      }
    },
    [changeRows],
  );
  const nextChange = useCallback(
    () => changeRows.length && scrollToChange(activeChangeIdx < changeRows.length - 1 ? activeChangeIdx + 1 : 0),
    [changeRows, activeChangeIdx, scrollToChange],
  );
  const prevChange = useCallback(
    () => changeRows.length && scrollToChange(activeChangeIdx > 0 ? activeChangeIdx - 1 : changeRows.length - 1),
    [changeRows, activeChangeIdx, scrollToChange],
  );

  // Keyboard: ⌘K or / → search; j / k → next / previous change.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (searchOpen || inspectedUnitId || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (comparing && e.key === "j") {
        e.preventDefault();
        nextChange();
      } else if (comparing && e.key === "k") {
        e.preventDefault();
        prevChange();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen, inspectedUnitId, comparing, nextChange, prevChange]);

  // Document title
  useEffect(() => {
    const base = "RISC-V 指令集手册";
    if (route.page === "chapter" && chapterMeta) {
      const raw = settings.lang === "en" ? chapterMeta.title_en : chapterMeta.title_zh || chapterMeta.title_en;
      document.title = `${cleanChapterTitle(raw)} · ${base}`;
    } else document.title = base;
  }, [route.page, chapterMeta, settings.lang]);

  const onInspect = useCallback((uid: string) => setInspectedUnitId(uid), []);
  const onCopyLink = useCallback(
    async (href: string) => {
      const url = absoluteUrl(parseHash(href));
      try {
        await navigator.clipboard.writeText(url);
        showToast("链接已复制");
      } catch {
        window.history.replaceState(window.history.state, "", href);
        showToast("已更新地址栏链接");
      }
    },
    [showToast],
  );

  const inspectedBlock = inspectedUnitId
    ? (target.bundle?.units[inspectedUnitId] ?? base.bundle?.units[inspectedUnitId] ?? null)
    : null;
  const inspectedAnchorId = useMemo(() => {
    if (!inspectedUnitId) return null;
    for (const b of [target.bundle, base.bundle]) {
      if (!b) continue;
      for (const sec of b.sections) {
        if (sec.heading_unit_id === inspectedUnitId) {
          return sec.heading_anchor_id ?? sec.id;
        }
        const hit = sec.blocks.find(
          (entry) => typeof entry !== "string" && entry.unit_id === inspectedUnitId,
        );
        if (hit && typeof hit !== "string" && hit.anchor_id) return hit.anchor_id;
      }
    }
    return null;
  }, [inspectedUnitId, target.bundle, base.bundle]);
  const inspectedPermalink = inspectedUnitId
    ? absoluteUrl(
        parseHash(
          makePermalink(inspectedAnchorId ?? `u-${inspectedUnitId.slice(0, 12)}`),
        ),
      )
    : null;

  // ------------------------------------------------------------- renders
  if (indexLoading) {
    return <Spinner label="正在加载手册…" />;
  }
  if (!index || !snapshot) {
    return (
      <SetupWelcome
        errorMessage={indexError}
        onLoadDemo={() => {
          setDemoMode(true);
          setIndex(getDemoSiteIndex());
        }}
      />
    );
  }

  const parent = parentSnapshot(index, snapshot);
  const fallbackBase =
    parent ?? index.snapshots[Math.max(0, index.snapshots.indexOf(snapshot) - 1)];
  const canCompare = route.page === "chapter" && index.snapshots.length > 1;

  const changedHere =
    snapshot.parent_sha && !snapshot.is_baseline ? (chapterMeta?.changed_blocks ?? 0) : 0;

  const refOf = (s: SiteSnapshot) => (s.sha === index.default_sha ? undefined : snapshotRef(s));

  const compareBar: CompareBarModel | null =
    comparing && baseSnapshot
      ? {
          base: baseSnapshot,
          target: snapshot,
          stats,
          changesOnly,
          onSelectBase: (s) => go({ ...route, cmp: snapshotRef(s), at: activeSectionId ?? undefined }),
          onSelectTarget: (s) => go({ ...route, v: snapshotRef(s), at: activeSectionId ?? undefined }),
          onToggleChangesOnly: setChangesOnly,
          onExit: () => go({ ...route, cmp: undefined, at: activeSectionId ?? undefined }),
        }
      : null;

  const compareState: CompareState | null =
    comparing && baseSnapshot
      ? {
          base: baseSnapshot,
          target: snapshot,
          baseBundle: base.bundle,
          rows,
          changesOnly,
          activeRowKey: activeChangeIdx >= 0 ? (changeRows[activeChangeIdx]?.rowKey ?? null) : null,
        }
      : null;

  const chapters = activeVolumeChapters;
  const chapterIdx = chapters.findIndex((c) => c.id === route.chapter);
  const showRail = route.page === "chapter";

  let page: React.ReactNode;
  if (route.page === "home") {
    page = (
      <HomePage
        index={index}
        snapshot={snapshot}
        volumes={targetTree.volumes}
        vParam={rV}
        lang={settings.lang}
      />
    );
  } else if (targetTree.loading && !activeVolume) {
    page = <Spinner label="正在加载目录…" />;
  } else if (!activeVolume || !chapterMeta) {
    page = (
      <div className="mx-auto max-w-md py-24 text-center">
        <p className="text-lg font-medium">未找到章节</p>
        <p className="mt-1.5 text-sm text-[var(--fg-muted)]">
          {snapshotLabel(snapshot)} · {route.chapter ?? route.volume}
        </p>
        <div className="mt-6 flex justify-center gap-3 text-sm">
          <a href={homeHref} className="rounded-lg border border-[var(--line)] px-3 py-1.5 hover:bg-[var(--bg-subtle)]">
            返回首页
          </a>
          {route.v && (
            <a
              href={formatHash({ ...route, v: undefined, cmp: undefined })}
              className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-white dark:text-[#141519]"
            >
              切换至默认版本
            </a>
          )}
        </div>
      </div>
    );
  } else {
    page = (
      <ChapterPage
        snapshot={snapshot}
        chapter={chapterMeta}
        bundle={target.bundle}
        loading={contentLoading}
        error={target.error ?? base.error}
        settings={settings}
        compare={compareState}
        changedHere={changedHere}
        prevChapter={chapterIdx > 0 ? chapters[chapterIdx - 1] : undefined}
        nextChapter={chapterIdx >= 0 ? chapters[chapterIdx + 1] : undefined}
        makePermalink={makePermalink}
        chapterHref={(id) => chapterHref(activeVolume.id, id)}
        onShowChanges={
          parent ? () => go({ ...route, cmp: snapshotRef(parent), at: undefined }) : undefined
        }
        onInspect={onInspect}
        onCopyLink={onCopyLink}
      />
    );
  }

  return (
    <div className="min-h-screen">
      <TopBar
        index={index}
        snapshot={snapshot}
        volumes={volumes}
        activeVolumeId={activeVolume?.id}
        chapterId={route.page === "chapter" ? route.chapter : undefined}
        sections={route.page === "chapter" ? sections : undefined}
        activeSectionId={route.page === "chapter" ? activeSectionId : null}
        sectionHref={makePermalink}
        homeHref={homeHref}
        demoMode={demoMode}
        settings={settings}
        onUpdateSettings={updateSetting}
        onSelectVolume={(v) => {
          const vol = volumes.find((x) => x.id === v);
          if (vol?.chapters[0]) go({ page: "chapter", volume: v, chapter: vol.chapters[0].id, v: rV });
        }}
        onSelectSnapshot={(s) =>
          go({ ...route, v: refOf(s), cmp: undefined, at: route.page === "chapter" ? (activeSectionId ?? undefined) : undefined })
        }
        canCompare={canCompare}
        compare={compareBar}
        onStartCompare={() =>
          fallbackBase &&
          fallbackBase.sha !== snapshot.sha &&
          go({ ...route, cmp: snapshotRef(fallbackBase), at: activeSectionId ?? undefined })
        }
        onOpenSearch={() => setSearchOpen(true)}
        onOpenMobileNav={() => setMobileNavOpen(true)}
      />

      <div className="mx-auto flex w-full max-w-[110rem]">
        <BookNav
          volumes={volumes}
          activeVolumeId={activeVolume?.id}
          activeChapterId={route.chapter}
          sections={sections}
          activeSectionId={activeSectionId}
          inlineSections={settings.lang === "parallel" ? "always" : "below-xl"}
          lang={settings.lang}
          page={route.page}
          chapterHref={chapterHref}
          sectionHref={makePermalink}
          mobileOpen={mobileNavOpen}
          onCloseMobile={() => setMobileNavOpen(false)}
          onSelectVolume={(v) => {
            const vol = volumes.find((x) => x.id === v);
            if (vol?.chapters[0]) go({ page: "chapter", volume: v, chapter: vol.chapters[0].id, v: rV });
          }}
        />

        <main className="min-w-0 flex-1 pt-6 pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] sm:px-10 sm:pt-10 lg:pt-14 xl:px-16">
          {page}
        </main>

        {showRail && (
          <aside
            className={cx(
              "hidden w-60 shrink-0 pt-14 pr-6",
              settings.lang === "parallel" ? "2xl:block" : "xl:block",
            )}
          >
            <PageToc
              sections={sections}
              activeId={activeSectionId}
              sectionHref={makePermalink}
              footer={
                <button
                  type="button"
                  onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
                  className="cursor-pointer text-[12.5px] text-[var(--fg-faint)] hover:text-[var(--fg)]"
                >
                  ↑ 回到顶部
                </button>
              }
            />
          </aside>
        )}
      </div>

      {/* Floating change navigator in compare mode */}
      {comparing && changeRows.length > 0 && !contentLoading && (
        <div className="pop-in fixed bottom-[max(1.25rem,calc(env(safe-area-inset-bottom)+0.5rem))] left-1/2 z-30 flex max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--bg-elevated)] p-1 text-[13px] whitespace-nowrap shadow-[var(--shadow-pop)]">
          <button
            type="button"
            onClick={prevChange}
            title="上一处变更 (k)"
            aria-label="上一处变更"
            className="inline-flex min-h-9 cursor-pointer items-center gap-1 rounded-full px-3.5 py-1.5 text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)] active:bg-[var(--bg-subtle)] sm:min-h-0 sm:px-3"
          >
            <ChevronUp className="h-4 w-4" /> <Kbd className="hidden sm:inline-flex">k</Kbd>
          </button>
          <span className="min-w-[3.5rem] px-1 text-center tabular-nums text-[var(--fg-muted)]">
            {activeChangeIdx >= 0 ? activeChangeIdx + 1 : "–"} / {changeRows.length}
          </span>
          <button
            type="button"
            onClick={nextChange}
            title="下一处变更 (j)"
            aria-label="下一处变更"
            className="inline-flex min-h-9 cursor-pointer items-center gap-1 rounded-full px-3.5 py-1.5 text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)] active:bg-[var(--bg-subtle)] sm:min-h-0 sm:px-3"
          >
            <Kbd className="hidden sm:inline-flex">j</Kbd> <ChevronDown className="h-4 w-4" />
          </button>
        </div>
      )}

      {toast && (
        <div className="pop-in fixed bottom-[max(5rem,calc(env(safe-area-inset-bottom)+4.25rem))] left-1/2 z-[70] max-w-[calc(100vw-2rem)] -translate-x-1/2 truncate rounded-full bg-[var(--fg)] px-4 py-2 text-center text-[13px] text-[var(--bg)] shadow-lg">
          {toast}
        </div>
      )}

      <SearchDialog
        open={searchOpen}
        demoMode={demoMode}
        dataVersion={dataVersion}
        lang={settings.lang}
        onClose={() => setSearchOpen(false)}
        onPick={(e: SearchEntry) =>
          go({
            page: "chapter",
            volume: e.volume_id,
            chapter: e.chapter_id,
            v: findChapter(targetTree.volumes, e.volume_id, e.chapter_id) ? rV : undefined,
            at: searchEntryAt(e),
          })
        }
      />

      <Inspector
        unitId={inspectedUnitId}
        block={inspectedBlock}
        anchorId={inspectedAnchorId}
        permalink={inspectedPermalink}
        dataRepoUrl={index.data_repo_url}
        upstreamRepoUrl={index.upstream_repo_url}
        demoMode={demoMode}
        dataVersion={dataVersion}
        onClose={() => setInspectedUnitId(null)}
      />
    </div>
  );
};

export default App;
