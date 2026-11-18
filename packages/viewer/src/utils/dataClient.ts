import {
  DEMO_ANCHORS,
  DEMO_META_SHARDS,
  DEMO_PACKS,
  DEMO_SEARCH_ENTRIES,
  DEMO_SITE_INDEX,
  DEMO_STRUCTURES,
  DEMO_TREES,
} from "../demoData";
import type {
  AnchorIndex,
  ChapterStructure,
  ChapterUnitPack,
  ResolvedChapter,
  SearchEntry,
  SiteChapterEntry,
  SiteIndex,
  SiteTree,
  UnitMeta,
  UnitMetaShard,
} from "../types";

export class DataNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataNotFoundError";
  }
}

export const DATA_BASE_URL = (import.meta.env.VITE_DATA_URL || "./data").replace(/\/+$/, "");

const treeCache = new Map<string, SiteTree>();
const structureCache = new Map<string, ChapterStructure>();
const packCache = new Map<string, ChapterUnitPack>();
const metaShardCache = new Map<string, UnitMetaShard>();
let anchorIndexCache: AnchorIndex | null = null;
let searchCache: SearchEntry[] | null = null;
let activeDataVersion: string | null = null;

/** Derives a deployment-scoped cache key from `SiteIndex` for unhashed JSON endpoints. */
export function siteDataVersion(
  index: Pick<SiteIndex, "generated_at" | "default_tree_hash">,
): string {
  return `${index.default_tree_hash}-${index.generated_at}`;
}

export function getActiveDataVersion(): string | null {
  return activeDataVersion;
}

export function setActiveDataVersion(version: string | null): void {
  if (activeDataVersion === version) return;
  activeDataVersion = version;
  metaShardCache.clear();
  anchorIndexCache = null;
  searchCache = null;
}

export function resetDataClientCachesForTest(): void {
  treeCache.clear();
  structureCache.clear();
  packCache.clear();
  metaShardCache.clear();
  anchorIndexCache = null;
  searchCache = null;
  activeDataVersion = null;
}

function versionedUrl(relPath: string): string {
  const url = `${DATA_BASE_URL}/${relPath.replace(/^\/+/, "")}`;
  if (!activeDataVersion) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${encodeURIComponent(activeDataVersion)}`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = init ? await fetch(url, init) : await fetch(url);
  if (res.status === 404) {
    throw new DataNotFoundError(`Resource not found: ${url}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const text = await res.text();
  if (text.trimStart().startsWith("<")) {
    throw new DataNotFoundError(`HTML fallback returned instead of JSON for ${url}`);
  }
  return JSON.parse(text) as T;
}

export interface FetchSiteIndexOptions {
  /** Bypass browser and edge caches when recovering a stale open tab after deployment. */
  bustCache?: boolean;
}

export async function fetchSiteIndex(options: FetchSiteIndexOptions = {}): Promise<SiteIndex> {
  const base = `${DATA_BASE_URL}/index.json`;
  const url = options.bustCache
    ? `${base}${base.includes("?") ? "&" : "?"}_=${Date.now()}`
    : base;
  const index = await fetchJson<SiteIndex>(url, {
    cache: options.bustCache ? "reload" : "no-cache",
  });
  setActiveDataVersion(siteDataVersion(index));
  return index;
}

export function getDemoSiteIndex(): SiteIndex {
  return DEMO_SITE_INDEX;
}

export async function fetchSiteTree(
  treeHash: string,
  index: SiteIndex | null,
  demoMode: boolean,
): Promise<SiteTree> {
  if (index && treeHash === index.default_tree_hash) {
    return {
      tree_hash: index.default_tree_hash,
      volumes: index.default_volumes,
    };
  }
  if (demoMode) {
    const demo = DEMO_TREES[treeHash];
    if (!demo) {
      throw new DataNotFoundError(`Demo site tree not found: ${treeHash}`);
    }
    return demo;
  }
  const cached = treeCache.get(treeHash);
  if (cached) return cached;
  const tree = await fetchJson<SiteTree>(`${DATA_BASE_URL}/trees/${treeHash}.json`);
  treeCache.set(treeHash, tree);
  return tree;
}

export async function fetchChapterStructure(
  structHash: string,
  demoMode: boolean,
): Promise<ChapterStructure> {
  if (demoMode) {
    const demo = DEMO_STRUCTURES[structHash];
    if (!demo) {
      throw new DataNotFoundError(`Demo chapter structure not found: ${structHash}`);
    }
    return demo;
  }
  const cached = structureCache.get(structHash);
  if (cached) return cached;
  const structure = await fetchJson<ChapterStructure>(
    `${DATA_BASE_URL}/chapters/${structHash}.json`,
  );
  structureCache.set(structHash, structure);
  return structure;
}

export async function fetchChapterUnitPack(
  packHash: string,
  demoMode: boolean,
): Promise<ChapterUnitPack> {
  if (demoMode) {
    const demo = DEMO_PACKS[packHash];
    if (!demo) {
      throw new DataNotFoundError(`Demo chapter unit pack not found: ${packHash}`);
    }
    return demo;
  }
  const cached = packCache.get(packHash);
  if (cached) return cached;
  const pack = await fetchJson<ChapterUnitPack>(`${DATA_BASE_URL}/packs/${packHash}.json`);
  packCache.set(packHash, pack);
  return pack;
}

export function resolveChapter(
  structure: ChapterStructure,
  pack: ChapterUnitPack,
): ResolvedChapter {
  let units = pack.units;
  const overrides = structure.unit_overrides;
  if (overrides && Object.keys(overrides).length > 0) {
    units = { ...pack.units };
    for (const [unitId, override] of Object.entries(overrides)) {
      const existing = units[unitId];
      if (!existing) continue;
      units[unitId] = {
        ...existing,
        en_html: override.en_html,
        ...(override.zh_html !== undefined ? { zh_html: override.zh_html } : {}),
      };
    }
  }
  return {
    struct_hash: structure.struct_hash,
    pack_hash: pack.pack_hash,
    volume_id: structure.volume_id,
    chapter_id: structure.chapter_id,
    sectname: structure.sectname,
    sectnum: structure.sectnum,
    title_en: structure.title_en,
    title_zh: structure.title_zh,
    title_unit_id: structure.title_unit_id,
    sections: structure.sections,
    units,
  };
}

export async function fetchResolvedChapter(
  entry: SiteChapterEntry,
  demoMode: boolean,
): Promise<ResolvedChapter> {
  const [structure, pack] = await Promise.all([
    fetchChapterStructure(entry.struct_hash, demoMode),
    fetchChapterUnitPack(entry.pack_hash, demoMode),
  ]);
  return resolveChapter(structure, pack);
}

export async function fetchAnchorIndex(demoMode: boolean): Promise<AnchorIndex> {
  if (demoMode) {
    return DEMO_ANCHORS;
  }
  if (anchorIndexCache) return anchorIndexCache;
  const anchors = await fetchJson<AnchorIndex>(versionedUrl("anchors.json"));
  anchorIndexCache = anchors;
  return anchors;
}

export async function fetchUnitMetaShard(
  prefix: string,
  demoMode: boolean,
): Promise<UnitMetaShard | null> {
  if (demoMode) {
    return DEMO_META_SHARDS[prefix] ?? null;
  }
  let shard = metaShardCache.get(prefix);
  if (!shard) {
    try {
      shard = await fetchJson<UnitMetaShard>(versionedUrl(`meta/${prefix}.json`));
      metaShardCache.set(prefix, shard);
    } catch (err) {
      if (err instanceof DataNotFoundError) {
        return null;
      }
      throw err;
    }
  }
  return shard;
}

export async function fetchUnitMeta(
  unitId: string,
  demoMode: boolean,
): Promise<UnitMeta | null> {
  const prefix = unitId.slice(0, 2);
  const shard = await fetchUnitMetaShard(prefix, demoMode);
  return shard?.[unitId] ?? null;
}

export async function fetchSearchIndex(demoMode: boolean): Promise<SearchEntry[]> {
  if (demoMode) {
    return DEMO_SEARCH_ENTRIES;
  }
  if (searchCache) return searchCache;
  const entries = await fetchJson<SearchEntry[]>(versionedUrl("search.json"));
  searchCache = entries;
  return entries;
}
