import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ChapterManifestSchema,
  SnapshotManifestSchema,
  blockEntryUnitId,
  compactBlockEntry,
  normalizeBlockEntry,
  type BlockEntry,
  type BlockRef,
  type ChapterManifest,
  type ChapterNode,
  type DeletedBlockRef,
  type DiffSummary,
  type Hex16,
  type SectionNode,
  type SnapshotManifest,
  type SnapshotSlotChange,
  type SnapshotVolume,
  type VolumeNode,
} from "@riscv-cn/schema";

export interface HydratedSnapshot {
  sha: string;
  parent_sha: string | null;
  is_baseline: boolean;
  date: string;
  title: string;
  ratified_tag: string | null;
  draft_tags: string[];
  diff: DiffSummary;
  deleted_blocks: DeletedBlockRef[];
  volumes: VolumeNode[];
}

export interface ChapterManifestContent {
  id: string;
  sectname: string;
  sectnum: string | null;
  title_en: string;
  title_unit_id?: string;
  source_path: string;
  sections: Array<{
    id: string;
    level: number;
    sectnum: string | null;
    title: string;
    heading_unit_id?: string;
    heading_anchor_id?: string;
    heading_extra_anchors?: string[];
    blocks: BlockEntry[];
  }>;
}

export function chapterManifestPath(dataDir: string, chapHash: string): string {
  return join(dataDir, "manifests", "chapters", `${chapHash}.json`);
}

export function snapshotManifestPath(dataDir: string, sha: string): string {
  return join(dataDir, "manifests", "snapshots", `${sha}.json`);
}

export function toChapterManifestContent(chap: ChapterNode): ChapterManifestContent {
  return {
    id: chap.id,
    sectname: chap.sectname,
    sectnum: chap.sectnum ?? null,
    title_en: chap.title_en,
    ...(chap.title_unit_id !== undefined ? { title_unit_id: chap.title_unit_id } : {}),
    source_path: chap.source_path,
    sections: chap.sections.map((sec) => {
      const headingExtras = sec.heading_extra_anchors?.filter((a) => a.length > 0);
      return {
        id: sec.id,
        level: sec.level,
        sectnum: sec.sectnum ?? null,
        title: sec.title,
        ...(sec.heading_unit_id !== undefined ? { heading_unit_id: sec.heading_unit_id } : {}),
        ...(sec.heading_anchor_id !== undefined
          ? { heading_anchor_id: sec.heading_anchor_id }
          : {}),
        ...(headingExtras && headingExtras.length > 0
          ? { heading_extra_anchors: [...headingExtras] }
          : {}),
        blocks: sec.blocks.map((b) =>
          compactBlockEntry({
            unit_id: b.unit_id,
            anchor_id: b.anchor_id,
            extra_anchors: b.extra_anchors,
          }),
        ),
      };
    }),
  };
}

export function computeChapterManifestHash(content: ChapterManifestContent): Hex16 {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 16);
}

export function toChapterManifest(chap: ChapterNode): ChapterManifest {
  const content = toChapterManifestContent(chap);
  const chapHash = computeChapterManifestHash(content);
  return ChapterManifestSchema.parse({
    chap_hash: chapHash,
    ...content,
  });
}

export function verifyChapterManifestHash(manifest: ChapterManifest): Hex16 {
  const content: ChapterManifestContent = {
    id: manifest.id,
    sectname: manifest.sectname,
    sectnum: manifest.sectnum ?? null,
    title_en: manifest.title_en,
    ...(manifest.title_unit_id !== undefined ? { title_unit_id: manifest.title_unit_id } : {}),
    source_path: manifest.source_path,
    sections: manifest.sections.map((sec) => {
      const headingExtras = sec.heading_extra_anchors?.filter((a) => a.length > 0);
      return {
        id: sec.id,
        level: sec.level,
        sectnum: sec.sectnum ?? null,
        title: sec.title,
        ...(sec.heading_unit_id !== undefined ? { heading_unit_id: sec.heading_unit_id } : {}),
        ...(sec.heading_anchor_id !== undefined
          ? { heading_anchor_id: sec.heading_anchor_id }
          : {}),
        ...(headingExtras && headingExtras.length > 0
          ? { heading_extra_anchors: [...headingExtras] }
          : {}),
        blocks: sec.blocks.map((b) => compactBlockEntry(normalizeBlockEntry(b))),
      };
    }),
  };
  return computeChapterManifestHash(content);
}

export function collectChapterUnitIds(chap: ChapterManifest): string[] {
  const seen = new Set<string>();
  const add = (id?: string) => {
    if (id && !seen.has(id)) {
      seen.add(id);
    }
  };
  add(chap.title_unit_id);
  for (const sec of chap.sections) {
    add(sec.heading_unit_id);
    for (const entry of sec.blocks) {
      add(blockEntryUnitId(entry));
    }
  }
  return [...seen];
}

export function dehydrateSnapshot(hydrated: HydratedSnapshot): {
  snapshot: SnapshotManifest;
  chapters: Map<string, ChapterManifest>;
} {
  const chapters = new Map<string, ChapterManifest>();
  const changes: SnapshotSlotChange[] = [];
  const volumes: SnapshotVolume[] = [];

  for (const vol of hydrated.volumes) {
    const chapRefs: SnapshotVolume["chapters"] = [];
    for (const chap of vol.chapters) {
      const chapManifest = toChapterManifest(chap);
      if (!chapters.has(chapManifest.chap_hash)) {
        chapters.set(chapManifest.chap_hash, chapManifest);
      }
      chapRefs.push({
        id: chap.id,
        chap_hash: chapManifest.chap_hash,
      });

      const chapterKey = `${vol.id}/${chap.id}`;
      for (const sec of chap.sections) {
        if (sec.heading_diff_status && sec.heading_unit_id) {
          changes.push({
            chapter_key: chapterKey,
            section_id: sec.id,
            slot: "heading",
            unit_id: sec.heading_unit_id,
            status: sec.heading_diff_status,
            ...(sec.heading_moved_from !== undefined
              ? { moved_from: sec.heading_moved_from }
              : {}),
            ...(sec.heading_prev_unit_id !== undefined
              ? { prev_unit_id: sec.heading_prev_unit_id }
              : {}),
          });
        }
        for (let idx = 0; idx < sec.blocks.length; idx++) {
          const b = sec.blocks[idx];
          if (b.diff_status) {
            changes.push({
              chapter_key: chapterKey,
              section_id: sec.id,
              slot: idx,
              unit_id: b.unit_id,
              status: b.diff_status,
              ...(b.moved_from !== undefined ? { moved_from: b.moved_from } : {}),
              ...(b.prev_unit_id !== undefined ? { prev_unit_id: b.prev_unit_id } : {}),
            });
          }
        }
      }
    }

    volumes.push({
      id: vol.id,
      title_en: vol.title_en,
      ...(vol.title_unit_id !== undefined ? { title_unit_id: vol.title_unit_id } : {}),
      ...(vol.title_prev_unit_id !== undefined
        ? { title_prev_unit_id: vol.title_prev_unit_id }
        : {}),
      entry_file: vol.entry_file,
      chapters: chapRefs,
    });
  }

  const snapshot = SnapshotManifestSchema.parse({
    sha: hydrated.sha,
    parent_sha: hydrated.parent_sha,
    is_baseline: hydrated.is_baseline,
    date: hydrated.date,
    title: hydrated.title,
    ratified_tag: hydrated.ratified_tag,
    draft_tags: hydrated.draft_tags,
    diff: hydrated.diff,
    changes,
    deleted_blocks: hydrated.deleted_blocks,
    volumes,
  });

  return { snapshot, chapters };
}

export function hydrateSnapshot(
  snapshot: SnapshotManifest,
  getChapter: (chapHash: string) => ChapterManifest,
): HydratedSnapshot {
  const changesByChapterKey = new Map<string, SnapshotSlotChange[]>();
  for (const chg of snapshot.changes) {
    let list = changesByChapterKey.get(chg.chapter_key);
    if (!list) {
      list = [];
      changesByChapterKey.set(chg.chapter_key, list);
    }
    list.push(chg);
  }

  const volumes: VolumeNode[] = snapshot.volumes.map((vol) => {
    const chapters: ChapterNode[] = vol.chapters.map((chapRef) => {
      const manifest = getChapter(chapRef.chap_hash);
      if (manifest.id !== chapRef.id) {
        throw new Error(
          `Snapshot ${snapshot.sha.slice(0, 10)} chapter id mismatch for ${vol.id}/${chapRef.id}: manifest ${chapRef.chap_hash} has id ${manifest.id}`,
        );
      }

      const sections: SectionNode[] = manifest.sections.map((sec) => ({
        id: sec.id,
        level: sec.level,
        sectnum: sec.sectnum ?? null,
        title: sec.title,
        ...(sec.heading_unit_id !== undefined ? { heading_unit_id: sec.heading_unit_id } : {}),
        ...(sec.heading_anchor_id !== undefined
          ? { heading_anchor_id: sec.heading_anchor_id }
          : {}),
        ...(sec.heading_extra_anchors !== undefined
          ? { heading_extra_anchors: [...sec.heading_extra_anchors] }
          : {}),
        blocks: sec.blocks.map((entry): BlockRef => {
          const norm = normalizeBlockEntry(entry);
          return {
            unit_id: norm.unit_id,
            ...(norm.anchor_id !== undefined ? { anchor_id: norm.anchor_id } : {}),
            ...(norm.extra_anchors !== undefined
              ? { extra_anchors: [...norm.extra_anchors] }
              : {}),
          };
        }),
      }));

      const chapterKey = `${vol.id}/${chapRef.id}`;
      const chapChanges = changesByChapterKey.get(chapterKey);
      if (chapChanges) {
        for (const change of chapChanges) {
          if (change.slot === "heading") {
            const targetSec =
              sections.find(
                (s) => s.id === change.section_id && s.heading_unit_id === change.unit_id,
              ) ?? sections.find((s) => s.id === change.section_id);
            if (!targetSec) {
              throw new Error(
                `Snapshot ${snapshot.sha.slice(0, 10)} change references missing section ${chapterKey}/${change.section_id}`,
              );
            }
            if (targetSec.heading_unit_id !== change.unit_id) {
              throw new Error(
                `Snapshot ${snapshot.sha.slice(0, 10)} heading change unit_id mismatch at ${chapterKey}/${change.section_id}: expected ${change.unit_id}, got ${targetSec.heading_unit_id ?? "none"}`,
              );
            }
            targetSec.heading_diff_status = change.status;
            if (change.moved_from !== undefined) {
              targetSec.heading_moved_from = change.moved_from;
            }
            if (change.prev_unit_id !== undefined) {
              targetSec.heading_prev_unit_id = change.prev_unit_id;
            }
          } else {
            const idx = change.slot;
            const targetSec =
              sections.find(
                (s) => s.id === change.section_id && s.blocks[idx]?.unit_id === change.unit_id,
              ) ?? sections.find((s) => s.id === change.section_id);
            if (!targetSec) {
              throw new Error(
                `Snapshot ${snapshot.sha.slice(0, 10)} change references missing section ${chapterKey}/${change.section_id}`,
              );
            }
            const blk = targetSec.blocks[idx];
            if (!blk) {
              throw new Error(
                `Snapshot ${snapshot.sha.slice(0, 10)} change references out-of-range slot ${idx} in ${chapterKey}/${change.section_id}`,
              );
            }
            if (blk.unit_id !== change.unit_id) {
              throw new Error(
                `Snapshot ${snapshot.sha.slice(0, 10)} change unit_id mismatch at ${chapterKey}/${change.section_id}[${idx}]: expected ${change.unit_id}, got ${blk.unit_id}`,
              );
            }
            blk.diff_status = change.status;
            if (change.moved_from !== undefined) {
              blk.moved_from = change.moved_from;
            }
            if (change.prev_unit_id !== undefined) {
              blk.prev_unit_id = change.prev_unit_id;
            }
          }
        }
      }

      return {
        id: manifest.id,
        sectname: manifest.sectname,
        sectnum: manifest.sectnum ?? null,
        title_en: manifest.title_en,
        ...(manifest.title_unit_id !== undefined ? { title_unit_id: manifest.title_unit_id } : {}),
        source_path: manifest.source_path,
        sections,
      };
    });

    return {
      id: vol.id,
      title_en: vol.title_en,
      ...(vol.title_unit_id !== undefined ? { title_unit_id: vol.title_unit_id } : {}),
      ...(vol.title_prev_unit_id !== undefined
        ? { title_prev_unit_id: vol.title_prev_unit_id }
        : {}),
      entry_file: vol.entry_file,
      chapters,
    };
  });

  return {
    sha: snapshot.sha,
    parent_sha: snapshot.parent_sha,
    is_baseline: snapshot.is_baseline,
    date: snapshot.date,
    title: snapshot.title,
    ratified_tag: snapshot.ratified_tag,
    draft_tags: snapshot.draft_tags,
    diff: snapshot.diff,
    deleted_blocks: snapshot.deleted_blocks,
    volumes,
  };
}

export function readChapterManifest(
  dataDir: string,
  chapHash: string,
  cache?: Map<string, ChapterManifest>,
): ChapterManifest {
  const cached = cache?.get(chapHash);
  if (cached) return cached;
  const path = chapterManifestPath(dataDir, chapHash);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ChapterManifest;
  cache?.set(chapHash, parsed);
  return parsed;
}

export function readSnapshotManifestRaw(dataDir: string, sha: string): SnapshotManifest {
  const path = snapshotManifestPath(dataDir, sha);
  return JSON.parse(readFileSync(path, "utf8")) as SnapshotManifest;
}

export function writeSnapshotManifestRaw(dataDir: string, snapshot: SnapshotManifest): void {
  const path = snapshotManifestPath(dataDir, snapshot.sha);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export function readHydratedSnapshot(
  dataDir: string,
  sha: string,
  chapterCache?: Map<string, ChapterManifest>,
): HydratedSnapshot {
  const raw = readSnapshotManifestRaw(dataDir, sha);
  return hydrateSnapshot(raw, (chapHash) => readChapterManifest(dataDir, chapHash, chapterCache));
}

export function writeHydratedSnapshot(
  dataDir: string,
  hydrated: HydratedSnapshot,
  writtenChapterHashes?: Set<string>,
  chapterCache?: Map<string, ChapterManifest>,
): SnapshotManifest {
  const { snapshot, chapters } = dehydrateSnapshot(hydrated);
  for (const [chapHash, chapManifest] of chapters) {
    chapterCache?.set(chapHash, chapManifest);
    if (writtenChapterHashes?.has(chapHash)) continue;
    const chapPath = chapterManifestPath(dataDir, chapHash);
    if (!existsSync(chapPath)) {
      mkdirSync(dirname(chapPath), { recursive: true });
      writeFileSync(chapPath, `${JSON.stringify(chapManifest, null, 2)}\n`, "utf8");
    }
    writtenChapterHashes?.add(chapHash);
  }
  writeSnapshotManifestRaw(dataDir, snapshot);
  return snapshot;
}
