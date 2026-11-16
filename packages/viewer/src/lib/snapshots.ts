import {
  blockEntryUnitId,
  type ResolvedChapter,
  type SiteChapter,
  type SiteIndex,
  type SiteSnapshot,
  type SiteVolume,
  type TranslationStatus,
  type VolumeId,
} from "../types";
import type { ReadingLang } from "./settings";

/** Stable, human-friendly ref for URLs: the ratified tag, else a SHA prefix. */
export function snapshotRef(s: SiteSnapshot): string {
  return s.ratified_tag ?? s.sha.slice(0, 10);
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function snapshotLabel(s: SiteSnapshot): string {
  return s.ratified_tag ?? shortSha(s.sha);
}

export function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

export function resolveSnapshot(
  index: SiteIndex,
  ref: string | undefined,
): SiteSnapshot | undefined {
  if (ref) {
    const byTag = index.snapshots.find((s) => s.ratified_tag === ref);
    if (byTag) return byTag;
    const lower = ref.toLowerCase();
    const bySha = index.snapshots.find((s) => s.sha.startsWith(lower));
    if (bySha) return bySha;
  }
  return (
    index.snapshots.find((s) => s.sha === index.default_sha) ??
    index.snapshots[index.snapshots.length - 1]
  );
}

export function findChapter(
  volumes: SiteVolume[] | undefined,
  volumeId: VolumeId | undefined,
  chapterId: string | undefined,
): SiteChapter | undefined {
  if (!volumes || !volumeId || !chapterId) return undefined;
  return volumes
    .find((v) => v.id === volumeId)
    ?.chapters.find((c) => c.id === chapterId);
}

const shaMaps = new WeakMap<SiteIndex, Map<string, SiteSnapshot>>();

function snapshotBySha(index: SiteIndex, sha: string): SiteSnapshot | undefined {
  let map = shaMaps.get(index);
  if (!map) {
    map = new Map(index.snapshots.map((s) => [s.sha, s]));
    shaMaps.set(index, map);
  }
  return map.get(sha);
}

export function parentSnapshot(
  index: SiteIndex,
  s: SiteSnapshot | undefined,
): SiteSnapshot | undefined {
  if (!s?.parent_sha) return undefined;
  return snapshotBySha(index, s.parent_sha);
}

/** Does this snapshot modify the given chapter? */
export function snapshotTouchesChapter(
  snapshot: SiteSnapshot,
  volumeId: VolumeId,
  chapterId: string,
): boolean {
  if (snapshot.is_baseline) return false;
  const touched = snapshot.diff.touched_chapters;
  return (
    touched.includes(chapterId) ||
    touched.includes(`${volumeId}/${chapterId}`) ||
    touched.includes(`${volumeId}:${chapterId}`)
  );
}

/** `priv/machine` → { volume: "priv", chapter: "machine" } */
export function parseTouchedChapter(
  key: string,
): { volume: VolumeId; chapter: string } | null {
  const m = key.match(/^(unpriv|priv|profiles|debug)[/:](.+)$/);
  if (!m) return null;
  return { volume: m[1] as VolumeId, chapter: m[2] };
}

export interface TranslationProgress {
  total: number;
  approved: number;
  machine: number;
  untranslated: number;
}

export function bundleProgress(chapter: ResolvedChapter): TranslationProgress {
  const p: TranslationProgress = {
    total: 0,
    approved: 0,
    machine: 0,
    untranslated: 0,
  };
  const seen = new Set<string>();
  const addUnit = (unitId: string | undefined) => {
    if (!unitId || seen.has(unitId)) return;
    seen.add(unitId);
    const u = chapter.units[unitId];
    if (!u || !u.translatable) return;
    p.total += 1;
    const hasZh = Boolean(u.zh_html?.trim());
    if (!hasZh || u.status === "untranslated") {
      p.untranslated += 1;
    } else if (u.status === "approved") {
      p.approved += 1;
    } else {
      p.machine += 1;
    }
  };

  addUnit(chapter.title_unit_id);
  for (const sec of chapter.sections) {
    addUnit(sec.heading_unit_id);
    for (const entry of sec.blocks) {
      addUnit(blockEntryUnitId(entry));
    }
  }
  return p;
}

export const STATUS_LABEL: Record<TranslationStatus, string> = {
  untranslated: "未翻译",
  machine: "机器翻译",
  approved: "已审校",
};

export const VOLUME_NUMERAL: Record<VolumeId, string> = {
  unpriv: "I",
  priv: "II",
  profiles: "III",
  debug: "IV",
};

/**
 * Strip redundant manual/book prefixes (e.g. "RISC-V 指令集手册 第一卷：非特权级架构" -> "非特权级架构")
 * so volume headings don't repeat the site title or volume numeral.
 */
export function cleanVolumeTitle(
  vol: Pick<SiteVolume, "id" | "title_en" | "title_zh">,
  lang: ReadingLang,
): string {
  const raw = (lang === "en" ? vol.title_en : vol.title_zh || vol.title_en).trim();
  const stripped = raw
    .replace(
      /^(?:The\s+)?RISC-V\s+Instruction\s+Set\s+Manual[,:\s—-]*(?:Volume\s+[IVX\d]+[,:\s—-]*)?/i,
      "",
    )
    .replace(
      /^RISC-V\s*指令集手册[\s，,：:—-]*(?:第[一二三四五六七八九十百\d]+卷|卷\s*[IVX\d]+)?[\s，,：:—-]*/i,
      "",
    )
    .replace(
      /^(?:Volume\s+[IVX\d]+|第[一二三四五六七八九十百\d]+卷|卷\s*[IVX\d]+)[\s，,：:—-]+/i,
      "",
    )
    .trim();
  return stripped || raw;
}

/**
 * Derive a compact navigation tab label from the volume's own title + Roman numeral
 * without hardcoding volume names in UI code.
 */
export function shortVolumeLabel(
  vol: Pick<SiteVolume, "id" | "title_en" | "title_zh">,
  lang: ReadingLang = "zh",
): string {
  const base = cleanVolumeTitle(vol, lang);
  let compact =
    lang === "en"
      ? base
          .replace(/^RISC-V\s+/i, "")
          .replace(/\s+(?:Instruction\s+Set\s+)?(?:Architecture|Specification)$/i, "")
          .trim()
      : base
          .replace(/^RISC-V\s*/i, "")
          .replace(/(?:指令集)?(?:架构|规范)$/, "")
          .trim();
  if (!compact) compact = base;
  const numeral = VOLUME_NUMERAL[vol.id];
  return numeral ? `${numeral} · ${compact}` : compact;
}

const CJK_RE = /[\u4e00-\u9fff]/;

/** Clean inline AsciiDoc backticks and normalize mixed straight quotes in Chinese headings. */
export function cleanChapterTitle(raw: string): string {
  let out = raw
    .replace(/"`([^`]+)`"/g, '"$1"')
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (CJK_RE.test(out)) {
    out = out
      .replace(/"([A-Za-z0-9*._/-]+)"/g, "“$1”")
      .replace(/([“”])\s*[,，]\s*/g, "$1 ");
  }
  return out;
}

/** Split a chapter title into a clean TOC label and optional spec version suffix (`Version 2.1` / `版本 2.1`). */
export function formatTocChapterTitle(
  ch: Pick<SiteChapter, "title_en" | "title_zh">,
  lang: ReadingLang,
): { title: string; version?: string } {
  const raw = (lang === "en" ? ch.title_en : ch.title_zh || ch.title_en) || ch.title_en;
  const cleaned = cleanChapterTitle(raw);
  const m = /^(.*?)\s*[,，]\s*(?:Version|版本)\s*([0-9]+(?:\.[0-9A-Za-z]+)*)\s*$/i.exec(cleaned);
  if (m && m[1].trim()) {
    return { title: m[1].trim(), version: m[2] };
  }
  return { title: cleaned };
}
