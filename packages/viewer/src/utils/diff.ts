import { diffWords, type Change } from "diff";
import { decode as decodeHtmlEntities } from "he";
import {
  normalizeBlockEntry,
  type CompareChangeKind,
  type CompareRow,
  type NormalizedBlockAnchor,
  type RenderedUnit,
  type ResolvedChapter,
} from "../types";

/**
 * Strip HTML tags from rendered fragments so word-level diffs can be
 * displayed safely as React text nodes without broken tag fragments.
 */
export function stripHtmlToText(htmlOrRaw: string): string {
  const withNewlines = htmlOrRaw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|pre)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ");
  const noTags = withNewlines.replace(/<[^>]+>/g, "");
  const decoded = decodeHtmlEntities(noTags);
  return decoded.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function computeTextWordDiff(before: string, after: string): Change[] {
  return diffWords(before, after);
}

interface FlattenedItem {
  index: number;
  unitId: string;
  sectionId: string;
  sectionTitleEn: string;
  sectionTitleZh: string;
  sectionLevel: number;
  sectionSectnum: string | null;
  opensSection: boolean;
  block: RenderedUnit;
  anchorId?: string;
  extraAnchors?: string[];
  prevUnitId?: string;
  ref?: NormalizedBlockAnchor;
}

function flattenChapter(chapter: ResolvedChapter): FlattenedItem[] {
  const items: FlattenedItem[] = [];
  for (const sec of chapter.sections) {
    if (sec.heading_unit_id) {
      const headingBlock = chapter.units[sec.heading_unit_id];
      if (headingBlock) {
        items.push({
          index: items.length,
          unitId: sec.heading_unit_id,
          sectionId: sec.id,
          sectionTitleEn: sec.title_en,
          sectionTitleZh: sec.title_zh,
          sectionLevel: sec.level,
          sectionSectnum: sec.sectnum,
          opensSection: true,
          block: headingBlock,
          anchorId: sec.heading_anchor_id,
          extraAnchors: sec.heading_extra_anchors,
          prevUnitId: headingBlock.prev_unit_id,
        });
      }
    }
    for (const entry of sec.blocks) {
      const ref = normalizeBlockEntry(entry);
      const block = chapter.units[ref.unit_id];
      if (!block) continue;
      items.push({
        index: items.length,
        unitId: ref.unit_id,
        sectionId: sec.id,
        sectionTitleEn: sec.title_en,
        sectionTitleZh: sec.title_zh,
        sectionLevel: sec.level,
        sectionSectnum: sec.sectnum,
        opensSection: false,
        block,
        anchorId: ref.anchor_id,
        extraAnchors: ref.extra_anchors,
        prevUnitId: block.prev_unit_id,
        ref,
      });
    }
  }
  return items;
}

function tokenizePlainText(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu);
  return new Set(matches ?? []);
}

function computeTokenJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const tok of smaller) {
    if (larger.has(tok)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function itemAnchors(item: FlattenedItem): string[] {
  const out: string[] = [];
  if (item.anchorId) out.push(item.anchorId);
  if (item.extraAnchors) {
    for (const extra of item.extraAnchors) {
      if (extra) out.push(extra);
    }
  }
  return out;
}

function collectAncestors(
  startId: string,
  parentLink: ReadonlyMap<string, string>,
  maxHops = 64,
): string[] {
  const out: string[] = [];
  const visited = new Set<string>([startId]);
  let cur = parentLink.get(startId);
  while (cur && !visited.has(cur) && out.length < maxHops) {
    visited.add(cur);
    out.push(cur);
    cur = parentLink.get(cur);
  }
  return out;
}

/**
 * Align blocks between a Base ResolvedChapter (A) and a Target ResolvedChapter (B)
 * by exact unit_id, multi-hop prev_unit_id lineage, anchors/section IDs, and
 * plain-English token Jaccard similarity (>= 0.60), preserving section order
 * and inserting deleted blocks right after their preceding matched unit.
 */
export function buildCompareRows(
  baseChapter: ResolvedChapter | null,
  targetChapter: ResolvedChapter | null,
  lineageMap?: ReadonlyMap<string, string>,
): CompareRow[] {
  if (!baseChapter && !targetChapter) return [];

  if (!baseChapter && targetChapter) {
    return flattenChapter(targetChapter).map((item, i) => ({
      rowKey: `add-${item.unitId}-${i}`,
      sectionId: item.sectionId,
      sectionTitleEn: item.sectionTitleEn,
      sectionTitleZh: item.sectionTitleZh,
      sectionLevel: item.sectionLevel,
      sectionSectnum: item.sectionSectnum,
      opensSection: item.opensSection,
      changeKind: "added",
      unitId: item.unitId,
      targetBlock: item.block,
      targetRef: item.ref,
      anchorId: item.anchorId,
      extraAnchors: item.extraAnchors,
    }));
  }

  if (baseChapter && !targetChapter) {
    return flattenChapter(baseChapter).map((item, i) => ({
      rowKey: `del-${item.unitId}-${i}`,
      sectionId: item.sectionId,
      sectionTitleEn: item.sectionTitleEn,
      sectionTitleZh: item.sectionTitleZh,
      sectionLevel: item.sectionLevel,
      sectionSectnum: item.sectionSectnum,
      opensSection: item.opensSection,
      changeKind: "deleted",
      unitId: item.unitId,
      baseBlock: item.block,
      baseRef: item.ref,
      anchorId: item.anchorId,
      extraAnchors: item.extraAnchors,
    }));
  }

  const baseItems = flattenChapter(baseChapter!);
  const targetItems = flattenChapter(targetChapter!);

  const parentLink = new Map<string, string>();
  if (lineageMap) {
    for (const [uid, prev] of lineageMap) {
      if (prev && prev !== uid) parentLink.set(uid, prev);
    }
  }
  for (const item of baseItems) {
    if (item.prevUnitId && item.prevUnitId !== item.unitId) {
      parentLink.set(item.unitId, item.prevUnitId);
    }
  }
  for (const item of targetItems) {
    if (item.prevUnitId && item.prevUnitId !== item.unitId) {
      parentLink.set(item.unitId, item.prevUnitId);
    }
  }

  const baseByUnitId = new Map<string, number[]>();
  const baseByAnchor = new Map<string, number[]>();
  const baseHeadingBySection = new Map<string, number>();

  for (const item of baseItems) {
    const uidList = baseByUnitId.get(item.unitId) ?? [];
    uidList.push(item.index);
    baseByUnitId.set(item.unitId, uidList);

    for (const anchor of itemAnchors(item)) {
      const aList = baseByAnchor.get(anchor) ?? [];
      aList.push(item.index);
      baseByAnchor.set(anchor, aList);
    }

    if (item.opensSection && !baseHeadingBySection.has(item.sectionId)) {
      baseHeadingBySection.set(item.sectionId, item.index);
    }
  }

  const matchedBaseIndices = new Set<number>();
  const matchedTarget = new Map<
    number,
    { baseIndex: number; changeKind: CompareChangeKind }
  >();

  const pairItems = (
    targetIndex: number,
    baseIndex: number,
    changeKind: CompareChangeKind,
  ) => {
    matchedBaseIndices.add(baseIndex);
    matchedTarget.set(targetIndex, { baseIndex, changeKind });
  };

  const firstUnmatched = (
    candidates: number[] | undefined,
    predicate?: (item: FlattenedItem) => boolean,
  ): number | undefined => {
    if (!candidates) return undefined;
    for (const idx of candidates) {
      if (matchedBaseIndices.has(idx)) continue;
      if (predicate && !predicate(baseItems[idx])) continue;
      return idx;
    }
    return undefined;
  };

  // Pass 1a: Exact unit_id in the same section -> unchanged
  for (const t of targetItems) {
    const match = firstUnmatched(
      baseByUnitId.get(t.unitId),
      (b) => b.sectionId === t.sectionId,
    );
    if (match !== undefined) {
      pairItems(t.index, match, "unchanged");
    }
  }

  // Pass 1b: Exact unit_id across sections -> moved (or unchanged if same section heading)
  for (const t of targetItems) {
    if (matchedTarget.has(t.index)) continue;
    const match = firstUnmatched(baseByUnitId.get(t.unitId));
    if (match !== undefined) {
      const b = baseItems[match];
      pairItems(t.index, match, b.sectionId === t.sectionId ? "unchanged" : "moved");
    }
  }

  // Pass 2: Multi-hop prev_unit_id lineage (forward A -> ... -> B and reverse B -> ... -> A)
  const baseIndicesByAncestor = new Map<string, number[]>();
  for (const b of baseItems) {
    if (matchedBaseIndices.has(b.index)) continue;
    for (const anc of collectAncestors(b.unitId, parentLink)) {
      const list = baseIndicesByAncestor.get(anc) ?? [];
      list.push(b.index);
      baseIndicesByAncestor.set(anc, list);
    }
  }

  for (const t of targetItems) {
    if (matchedTarget.has(t.index)) continue;
    const targetAncestors = collectAncestors(t.unitId, parentLink);
    let matchedBase: number | undefined;
    for (const anc of targetAncestors) {
      matchedBase =
        firstUnmatched(baseByUnitId.get(anc), (b) => b.sectionId === t.sectionId) ??
        firstUnmatched(baseByUnitId.get(anc));
      if (matchedBase !== undefined) break;
    }
    if (matchedBase === undefined) {
      matchedBase =
        firstUnmatched(
          baseIndicesByAncestor.get(t.unitId),
          (b) => b.sectionId === t.sectionId,
        ) ?? firstUnmatched(baseIndicesByAncestor.get(t.unitId));
    }
    if (matchedBase !== undefined) {
      pairItems(t.index, matchedBase, "modified");
    }
  }

  // Pass 3: Shared anchor_id / extra_anchors or section heading ID with matching kind
  for (const t of targetItems) {
    if (matchedTarget.has(t.index)) continue;
    let matchedBase: number | undefined;

    for (const anchor of itemAnchors(t)) {
      const candidates = baseByAnchor.get(anchor);
      matchedBase =
        firstUnmatched(
          candidates,
          (b) => b.block.kind === t.block.kind && b.sectionId === t.sectionId,
        ) ?? firstUnmatched(candidates, (b) => b.block.kind === t.block.kind);
      if (matchedBase !== undefined) break;
    }

    if (matchedBase === undefined && t.opensSection) {
      const headingBaseIdx = baseHeadingBySection.get(t.sectionId);
      if (
        headingBaseIdx !== undefined &&
        !matchedBaseIndices.has(headingBaseIdx) &&
        baseItems[headingBaseIdx].block.kind === t.block.kind
      ) {
        matchedBase = headingBaseIdx;
      }
    }

    if (matchedBase !== undefined) {
      const b = baseItems[matchedBase];
      const kind: CompareChangeKind =
        b.unitId === t.unitId
          ? b.sectionId === t.sectionId
            ? "unchanged"
            : "moved"
          : "modified";
      pairItems(t.index, matchedBase, kind);
    }
  }

  // Pass 4: Token-Jaccard >= 0.60 on plain English within the same BlockKind
  const unmatchedTargets = targetItems.filter((t) => !matchedTarget.has(t.index));
  const unmatchedBases = baseItems.filter((b) => !matchedBaseIndices.has(b.index));

  if (unmatchedTargets.length > 0 && unmatchedBases.length > 0) {
    const targetTokens = new Map<number, Set<string>>();
    const baseTokens = new Map<number, Set<string>>();
    for (const t of unmatchedTargets) {
      targetTokens.set(t.index, tokenizePlainText(stripHtmlToText(t.block.en_html)));
    }
    for (const b of unmatchedBases) {
      baseTokens.set(b.index, tokenizePlainText(stripHtmlToText(b.block.en_html)));
    }

    interface JaccardCandidate {
      targetIndex: number;
      baseIndex: number;
      score: number;
    }
    const candidates: JaccardCandidate[] = [];
    for (const t of unmatchedTargets) {
      const tTok = targetTokens.get(t.index)!;
      if (tTok.size === 0) continue;
      for (const b of unmatchedBases) {
        if (b.block.kind !== t.block.kind) continue;
        const bTok = baseTokens.get(b.index)!;
        const jaccard = computeTokenJaccard(tTok, bTok);
        if (jaccard < 0.6) continue;
        const sameSectionBonus = b.sectionId === t.sectionId ? 1 : 0;
        const score = 0.85 * jaccard + 0.15 * sameSectionBonus;
        candidates.push({ targetIndex: t.index, baseIndex: b.index, score });
      }
    }

    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        Math.abs(a.targetIndex - a.baseIndex) - Math.abs(b.targetIndex - b.baseIndex) ||
        a.targetIndex - b.targetIndex ||
        a.baseIndex - b.baseIndex,
    );

    for (const cand of candidates) {
      if (matchedTarget.has(cand.targetIndex) || matchedBaseIndices.has(cand.baseIndex)) {
        continue;
      }
      const b = baseItems[cand.baseIndex];
      const t = targetItems[cand.targetIndex];
      const kind: CompareChangeKind = b.unitId === t.unitId ? "moved" : "modified";
      pairItems(cand.targetIndex, cand.baseIndex, kind);
    }
  }

  // Build ordered rows with leading and interleaved deletions
  const baseToTargetIndex = new Map<number, number>();
  for (const [tIdx, m] of matchedTarget) {
    baseToTargetIndex.set(m.baseIndex, tIdx);
  }

  const leadingDeleted: FlattenedItem[] = [];
  const trailingDeletedAfterTarget = new Map<number, FlattenedItem[]>();
  let currentMatchedTargetIdx: number | null = null;

  for (const b of baseItems) {
    const tIdx = baseToTargetIndex.get(b.index);
    if (tIdx !== undefined) {
      currentMatchedTargetIdx = tIdx;
    } else if (currentMatchedTargetIdx === null) {
      leadingDeleted.push(b);
    } else {
      const list = trailingDeletedAfterTarget.get(currentMatchedTargetIdx) ?? [];
      list.push(b);
      trailingDeletedAfterTarget.set(currentMatchedTargetIdx, list);
    }
  }

  const rows: CompareRow[] = [];
  const pushDeleted = (del: FlattenedItem) => {
    rows.push({
      rowKey: `del-${del.unitId}-${del.index}`,
      sectionId: del.sectionId,
      sectionTitleEn: del.sectionTitleEn,
      sectionTitleZh: del.sectionTitleZh,
      sectionLevel: del.sectionLevel,
      sectionSectnum: del.sectionSectnum,
      opensSection: del.opensSection,
      changeKind: "deleted",
      unitId: del.unitId,
      baseBlock: del.block,
      baseRef: del.ref,
      anchorId: del.anchorId,
      extraAnchors: del.extraAnchors,
    });
  };

  for (const del of leadingDeleted) {
    pushDeleted(del);
  }

  for (const t of targetItems) {
    const match = matchedTarget.get(t.index);
    if (match) {
      const b = baseItems[match.baseIndex];
      rows.push({
        rowKey: `cmp-${t.unitId}-${t.index}`,
        sectionId: t.sectionId,
        sectionTitleEn: t.sectionTitleEn,
        sectionTitleZh: t.sectionTitleZh,
        sectionLevel: t.sectionLevel,
        sectionSectnum: t.sectionSectnum,
        opensSection: t.opensSection,
        changeKind: match.changeKind,
        unitId: t.unitId,
        baseBlock: b.block,
        targetBlock: t.block,
        baseRef: b.ref,
        targetRef: t.ref,
        anchorId: t.anchorId ?? b.anchorId,
        extraAnchors: t.extraAnchors ?? b.extraAnchors,
        movedFromSection:
          b.sectionId !== t.sectionId
            ? b.sectionTitleZh || b.sectionTitleEn || b.sectionId
            : undefined,
      });
    } else {
      rows.push({
        rowKey: `add-${t.unitId}-${t.index}`,
        sectionId: t.sectionId,
        sectionTitleEn: t.sectionTitleEn,
        sectionTitleZh: t.sectionTitleZh,
        sectionLevel: t.sectionLevel,
        sectionSectnum: t.sectionSectnum,
        opensSection: t.opensSection,
        changeKind: "added",
        unitId: t.unitId,
        targetBlock: t.block,
        targetRef: t.ref,
        anchorId: t.anchorId,
        extraAnchors: t.extraAnchors,
      });
    }

    const trailing = trailingDeletedAfterTarget.get(t.index);
    if (trailing) {
      for (const del of trailing) {
        pushDeleted(del);
      }
    }
  }

  return rows;
}
