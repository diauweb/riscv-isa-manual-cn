import type {
  BlockRef,
  DeletedBlockRef,
  DiffStatus,
  DiffSummary,
  VolumeId,
  VolumeNode,
} from "@riscv-cn/schema";
import type { ExtractedUnit } from "../parser/index.ts";

export interface SnapshotInput {
  volumes: VolumeNode[];
  units: Map<string, ExtractedUnit>;
}

export interface DiffResult {
  volumes: VolumeNode[];
  is_baseline: boolean;
  diff: DiffSummary;
  deleted_blocks: DeletedBlockRef[];
  prevUnitMap: Map<string, string>;
}

const MATCH_THRESHOLD = 0.65;
const TEXT_WEIGHT = 0.85;
const PATH_WEIGHT = 0.15;
const HUNGARIAN_LIMIT = 150;

interface BlockOccurrence {
  unit_id: string;
  volume_id: VolumeId;
  chapter_id: string;
  chapter_key: string;
  section_id: string;
  chapter_source_path: string;
  path: string;
  after_unit_id: string | null;
  applyDiff: (
    diffStatus: DiffStatus,
    movedFrom?: string,
    prevUnitId?: string,
  ) => void;
  unit?: ExtractedUnit;
}

export function tokenizeText(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  return new Set(matches ?? []);
}

export function tokenJaccard(
  a: Set<string> | string,
  b: Set<string> | string,
): number {
  const setA = typeof a === "string" ? tokenizeText(a) : a;
  const setB = typeof b === "string" ? tokenizeText(b) : b;
  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let intersection = 0;
  for (const tok of smaller) {
    if (larger.has(tok)) {
      intersection++;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function pathSimilarity(pathA: string, pathB: string): number {
  if (pathA === pathB) return 1;
  const segsA = pathA.split("/");
  const segsB = pathB.split("/");
  const maxLen = Math.max(segsA.length, segsB.length);
  if (maxLen === 0) return 1;
  let matches = 0;
  const minLen = Math.min(segsA.length, segsB.length);
  for (let i = 0; i < minLen; i++) {
    if (segsA[i] === segsB[i]) {
      matches++;
    }
  }
  return matches / maxLen;
}

function stripBlockDiff(blk: BlockRef): BlockRef {
  const { diff_status: _d, moved_from: _m, prev_unit_id: _p, ...rest } = blk;
  return rest;
}

function cloneVolumes(volumes: VolumeNode[]): VolumeNode[] {
  return volumes.map((vol) => {
    const { title_prev_unit_id: _tp, ...volRest } = vol;
    return {
      ...volRest,
      chapters: vol.chapters.map((ch) => ({
        ...ch,
        sections: ch.sections.map((sec) => {
          const {
            heading_diff_status: _hd,
            heading_moved_from: _hm,
            heading_prev_unit_id: _hp,
            ...secRest
          } = sec;
          return {
            ...secRest,
            blocks: sec.blocks.map(stripBlockDiff),
          };
        }),
      })),
    };
  });
}

function flattenOccurrences(
  volumes: VolumeNode[],
  units: Map<string, ExtractedUnit>,
): BlockOccurrence[] {
  const list: BlockOccurrence[] = [];
  for (const vol of volumes) {
    for (const ch of vol.chapters) {
      const chapterKey = `${vol.id}/${ch.id}`;
      for (const sec of ch.sections) {
        const path = `${vol.id}/${ch.id}/${sec.id}`;
        let prevUnitId: string | null = null;
        if (sec.heading_unit_id) {
          const headingUid = sec.heading_unit_id;
          list.push({
            unit_id: headingUid,
            volume_id: vol.id,
            chapter_id: ch.id,
            chapter_key: chapterKey,
            section_id: sec.id,
            chapter_source_path: ch.source_path,
            path,
            after_unit_id: null,
            unit: units.get(headingUid),
            applyDiff: (diffStatus, movedFrom, prev) => {
              sec.heading_diff_status = diffStatus;
              if (movedFrom !== undefined) {
                sec.heading_moved_from = movedFrom;
              }
              if (prev !== undefined) {
                sec.heading_prev_unit_id = prev;
              }
            },
          });
          prevUnitId = headingUid;
        }
        for (const blk of sec.blocks) {
          list.push({
            unit_id: blk.unit_id,
            volume_id: vol.id,
            chapter_id: ch.id,
            chapter_key: chapterKey,
            section_id: sec.id,
            chapter_source_path: ch.source_path,
            path,
            after_unit_id: prevUnitId,
            unit: units.get(blk.unit_id),
            applyDiff: (diffStatus, movedFrom, prev) => {
              blk.diff_status = diffStatus;
              if (movedFrom !== undefined) {
                blk.moved_from = movedFrom;
              }
              if (prev !== undefined) {
                blk.prev_unit_id = prev;
              }
            },
          });
          prevUnitId = blk.unit_id;
        }
      }
    }
  }
  return list;
}

/**
 * Exact O(N^3) maximum-weight bipartite matching via Kuhn-Munkres (Hungarian) algorithm.
 * Returns matched `[leftIdx, rightIdx]` pairs where weight >= threshold.
 */
function hungarianMatch(
  leftCount: number,
  rightCount: number,
  weights: number[][],
): Array<[number, number]> {
  const N = Math.max(leftCount, rightCount);
  const INF = 1e18;
  const cost: number[][] = Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) =>
      i < leftCount && j < rightCount ? -weights[i][j] : 0,
    ),
  );

  const u = new Float64Array(N + 1);
  const v = new Float64Array(N + 1);
  const p = new Int32Array(N + 1);
  const way = new Int32Array(N + 1);

  for (let i = 1; i <= N; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(N + 1).fill(INF);
    const used = new Uint8Array(N + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= N; j++) {
        if (!used[j]) {
          const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }
      }
      for (let j = 0; j <= N; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const pairs: Array<[number, number]> = [];
  for (let j = 1; j <= N; j++) {
    const i = p[j] - 1;
    const r = j - 1;
    if (i >= 0 && i < leftCount && r < rightCount && weights[i][r] >= MATCH_THRESHOLD) {
      pairs.push([i, r]);
    }
  }
  return pairs;
}

interface CandidateEdge {
  leftIdx: number;
  rightIdx: number;
  score: number;
}

function solveBipartiteMatching(
  remParent: BlockOccurrence[],
  remChild: BlockOccurrence[],
): CandidateEdge[] {
  if (remParent.length === 0 || remChild.length === 0) {
    return [];
  }

  const parentTokens = remParent.map((p) => tokenizeText(p.unit?.en ?? ""));
  const childTokens = remChild.map((c) => tokenizeText(c.unit?.en ?? ""));

  // Inverted index by kind -> token -> parent indices
  const indexByKind = new Map<string, Map<string, number[]>>();
  for (let i = 0; i < remParent.length; i++) {
    const kind = remParent[i].unit?.kind ?? "paragraph";
    let tokenMap = indexByKind.get(kind);
    if (!tokenMap) {
      tokenMap = new Map();
      indexByKind.set(kind, tokenMap);
    }
    for (const tok of parentTokens[i]) {
      let bucket = tokenMap.get(tok);
      if (!bucket) {
        bucket = [];
        tokenMap.set(tok, bucket);
      }
      bucket.push(i);
    }
  }

  const minJaccardBound = (MATCH_THRESHOLD - PATH_WEIGHT) / TEXT_WEIGHT;
  const edges: CandidateEdge[] = [];
  const leftAdj = new Map<number, CandidateEdge[]>();
  const rightAdj = new Map<number, CandidateEdge[]>();

  for (let j = 0; j < remChild.length; j++) {
    const c = remChild[j];
    const cToks = childTokens[j];
    const kind = c.unit?.kind ?? "paragraph";
    const tokenMap = indexByKind.get(kind);
    if (!tokenMap || cToks.size === 0) continue;

    const candidates = new Set<number>();
    for (const tok of cToks) {
      const bucket = tokenMap.get(tok);
      if (bucket) {
        for (const i of bucket) {
          candidates.add(i);
        }
      }
    }

    for (const i of candidates) {
      const pToks = parentTokens[i];
      const maxSize = Math.max(pToks.size, cToks.size);
      const minSize = Math.min(pToks.size, cToks.size);
      if (maxSize > 0 && minSize / maxSize < minJaccardBound) {
        continue;
      }

      const jacc = tokenJaccard(pToks, cToks);
      const pSim = pathSimilarity(remParent[i].path, c.path);
      const score = TEXT_WEIGHT * jacc + PATH_WEIGHT * pSim;
      if (score >= MATCH_THRESHOLD) {
        const edge: CandidateEdge = { leftIdx: i, rightIdx: j, score };
        edges.push(edge);
        let lList = leftAdj.get(i);
        if (!lList) {
          lList = [];
          leftAdj.set(i, lList);
        }
        lList.push(edge);
        let rList = rightAdj.get(j);
        if (!rList) {
          rList = [];
          rightAdj.set(j, rList);
        }
        rList.push(edge);
      }
    }
  }

  if (edges.length === 0) {
    return [];
  }

  // Solve per connected component so small groups run exact Hungarian in microseconds
  const visitedLeft = new Set<number>();
  const visitedRight = new Set<number>();
  const matched: CandidateEdge[] = [];

  for (const startLeft of leftAdj.keys()) {
    if (visitedLeft.has(startLeft)) continue;

    const compLeft: number[] = [];
    const compRight: number[] = [];
    const queue: Array<{ side: "L" | "R"; idx: number }> = [
      { side: "L", idx: startLeft },
    ];
    visitedLeft.add(startLeft);

    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.side === "L") {
        compLeft.push(cur.idx);
        for (const e of leftAdj.get(cur.idx) ?? []) {
          if (!visitedRight.has(e.rightIdx)) {
            visitedRight.add(e.rightIdx);
            queue.push({ side: "R", idx: e.rightIdx });
          }
        }
      } else {
        compRight.push(cur.idx);
        for (const e of rightAdj.get(cur.idx) ?? []) {
          if (!visitedLeft.has(e.leftIdx)) {
            visitedLeft.add(e.leftIdx);
            queue.push({ side: "L", idx: e.leftIdx });
          }
        }
      }
    }

    if (compLeft.length === 1 && compRight.length === 1) {
      const e = leftAdj.get(compLeft[0])![0];
      matched.push(e);
      continue;
    }

    if (Math.max(compLeft.length, compRight.length) <= HUNGARIAN_LIMIT) {
      const leftPos = new Map<number, number>();
      compLeft.forEach((l, idx) => leftPos.set(l, idx));
      const rightPos = new Map<number, number>();
      compRight.forEach((r, idx) => rightPos.set(r, idx));

      const weights: number[][] = Array.from({ length: compLeft.length }, () =>
        Array.from({ length: compRight.length }, () => 0),
      );

      for (const l of compLeft) {
        const li = leftPos.get(l)!;
        for (const e of leftAdj.get(l) ?? []) {
          const rj = rightPos.get(e.rightIdx);
          if (rj !== undefined) {
            weights[li][rj] = e.score;
          }
        }
      }

      const pairs = hungarianMatch(compLeft.length, compRight.length, weights);
      for (const [li, rj] of pairs) {
        matched.push({
          leftIdx: compLeft[li],
          rightIdx: compRight[rj],
          score: weights[li][rj],
        });
      }
    } else {
      // Greedy optimal fallback for very large connected components
      const compEdges: CandidateEdge[] = [];
      for (const l of compLeft) {
        compEdges.push(...(leftAdj.get(l) ?? []));
      }
      compEdges.sort((a, b) => b.score - a.score);
      const usedL = new Set<number>();
      const usedR = new Set<number>();
      for (const e of compEdges) {
        if (!usedL.has(e.leftIdx) && !usedR.has(e.rightIdx)) {
          usedL.add(e.leftIdx);
          usedR.add(e.rightIdx);
          matched.push(e);
        }
      }
    }
  }

  return matched;
}

/**
 * Diff a `parent` snapshot against a `child` snapshot:
 * 1. Lock exact `unit_id` matches (omitted/unchanged or `moved`).
 * 2. Run 1-to-1 MWBM (`>= 0.65`) on remaining units (`modified` + `prev_unit_id`).
 * 3. Label remaining `added` and `deleted_blocks` + compute `DiffSummary`.
 */
export function diffSnapshots(
  parent: SnapshotInput | null,
  child: SnapshotInput,
): DiffResult {
  const volumes = cloneVolumes(child.volumes);
  const childOccs = flattenOccurrences(volumes, child.units);
  const prevUnitMap = new Map<string, string>();
  const deleted_blocks: DeletedBlockRef[] = [];
  const touchedSet = new Set<string>();

  if (parent === null) {
    return {
      volumes,
      is_baseline: true,
      diff: {
        added: 0,
        modified: 0,
        moved: 0,
        deleted: 0,
        touched_chapters: [],
      },
      deleted_blocks,
      prevUnitMap,
    };
  }

  // Track volume title unit lineage
  const parentVolById = new Map(parent.volumes.map((v) => [v.id, v]));
  for (const childVol of volumes) {
    const parentVol = parentVolById.get(childVol.id);
    if (
      parentVol?.title_unit_id &&
      childVol.title_unit_id &&
      parentVol.title_unit_id !== childVol.title_unit_id
    ) {
      childVol.title_prev_unit_id = parentVol.title_unit_id;
      prevUnitMap.set(childVol.title_unit_id, parentVol.title_unit_id);
    }
  }

  const parentOccs = flattenOccurrences(parent.volumes, parent.units);
  const parentMatched = new Uint8Array(parentOccs.length);
  const childMatched = new Uint8Array(childOccs.length);

  // Step 1: Lock exact unit_id matches in 3 subpasses so moved duplicates never steal unchanged slots
  const parentByUnitId = new Map<string, number[]>();
  for (let i = 0; i < parentOccs.length; i++) {
    const uid = parentOccs[i].unit_id;
    let bucket = parentByUnitId.get(uid);
    if (!bucket) {
      bucket = [];
      parentByUnitId.set(uid, bucket);
    }
    bucket.push(i);
  }

  let movedCount = 0;

  // Pass 1a: Exact (unit_id, path, chapter_source_path)
  for (let j = 0; j < childOccs.length; j++) {
    const c = childOccs[j];
    const bucket = parentByUnitId.get(c.unit_id);
    if (!bucket || bucket.length === 0) {
      continue;
    }
    const pickPos = bucket.findIndex(
      (pi) =>
        parentOccs[pi].path === c.path &&
        parentOccs[pi].chapter_source_path === c.chapter_source_path,
    );
    if (pickPos === -1) {
      continue;
    }
    const pi = bucket.splice(pickPos, 1)[0];
    parentMatched[pi] = 1;
    childMatched[j] = 1;
  }

  // Pass 1b: Same logical path (unit_id, path), different chapter_source_path
  for (let j = 0; j < childOccs.length; j++) {
    if (childMatched[j]) {
      continue;
    }
    const c = childOccs[j];
    const bucket = parentByUnitId.get(c.unit_id);
    if (!bucket || bucket.length === 0) {
      continue;
    }
    const pickPos = bucket.findIndex((pi) => parentOccs[pi].path === c.path);
    if (pickPos === -1) {
      continue;
    }
    const pi = bucket.splice(pickPos, 1)[0];
    const p = parentOccs[pi];
    parentMatched[pi] = 1;
    childMatched[j] = 1;
    c.applyDiff("moved", `${p.chapter_source_path}#${p.section_id}`);
    movedCount++;
    touchedSet.add(c.chapter_key);
  }

  // Pass 1c: Remaining exact unit_id matches across different paths
  for (let j = 0; j < childOccs.length; j++) {
    if (childMatched[j]) {
      continue;
    }
    const c = childOccs[j];
    const bucket = parentByUnitId.get(c.unit_id);
    if (!bucket || bucket.length === 0) {
      continue;
    }
    const pi = bucket.shift()!;
    const p = parentOccs[pi];
    parentMatched[pi] = 1;
    childMatched[j] = 1;
    const movedFrom =
      p.path !== c.path
        ? p.path
        : `${p.chapter_source_path}#${p.section_id}`;
    c.applyDiff("moved", movedFrom);
    movedCount++;
    touchedSet.add(c.chapter_key);
  }

  // Step 2: 1-to-1 MWBM on remaining unmatched units
  const remParentIndices: number[] = [];
  const remParent: BlockOccurrence[] = [];
  for (let i = 0; i < parentOccs.length; i++) {
    if (!parentMatched[i]) {
      remParentIndices.push(i);
      remParent.push(parentOccs[i]);
    }
  }

  const remChildIndices: number[] = [];
  const remChild: BlockOccurrence[] = [];
  for (let j = 0; j < childOccs.length; j++) {
    if (!childMatched[j]) {
      remChildIndices.push(j);
      remChild.push(childOccs[j]);
    }
  }

  const mwbmMatches = solveBipartiteMatching(remParent, remChild);
  let modifiedCount = 0;
  for (const m of mwbmMatches) {
    const pi = remParentIndices[m.leftIdx];
    const cj = remChildIndices[m.rightIdx];
    const p = parentOccs[pi];
    const c = childOccs[cj];

    parentMatched[pi] = 1;
    childMatched[cj] = 1;

    c.applyDiff("modified", undefined, p.unit_id);
    prevUnitMap.set(c.unit_id, p.unit_id);
    modifiedCount++;
    touchedSet.add(c.chapter_key);
  }

  // Step 3: Remaining added & deleted
  let addedCount = 0;
  for (let j = 0; j < childOccs.length; j++) {
    if (!childMatched[j]) {
      const c = childOccs[j];
      c.applyDiff("added");
      addedCount++;
      touchedSet.add(c.chapter_key);
    }
  }

  for (let i = 0; i < parentOccs.length; i++) {
    if (!parentMatched[i]) {
      const p = parentOccs[i];
      deleted_blocks.push({
        chapter_key: p.chapter_key,
        section_id: p.section_id,
        after_unit_id: p.after_unit_id,
        unit_id: p.unit_id,
      });
      touchedSet.add(p.chapter_key);
    }
  }

  return {
    volumes,
    is_baseline: false,
    diff: {
      added: addedCount,
      modified: modifiedCount,
      moved: movedCount,
      deleted: deleted_blocks.length,
      touched_chapters: Array.from(touchedSet).sort((a, b) =>
        a.localeCompare(b),
      ),
    },
    deleted_blocks,
    prevUnitMap,
  };
}
