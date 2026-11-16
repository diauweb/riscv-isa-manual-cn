import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ChapterManifestSchema,
  ManifestIndexSchema,
  SnapshotManifestSchema,
  blockEntryUnitId,
  type SnapshotManifest,
  type SnapshotSlotChange,
} from "@riscv-cn/schema";
import { isVerbose, vlog } from "../log.ts";
import { collectChapterUnitIds, verifyChapterManifestHash } from "../manifests/index.ts";
import {
  chunkArray,
  createWorkerPool,
  defaultJobs,
  MIN_PARALLEL_ITEMS,
  MIN_PARALLEL_SNAPSHOTS,
} from "../parallel/index.ts";
import { computeUnitId } from "../parser/hash.ts";
import { createProgress } from "../progress.ts";
import { parseUnitToml } from "../toml/index.ts";

export interface ValidateDataOptions {
  jobs?: number;
}

export interface ValidateDataResult {
  ok: boolean;
  errors: string[];
  unitCount: number;
  chapterCount: number;
  snapshotCount: number;
}

export interface ValidatedChapterSummary {
  chapHash: string;
  id: string;
  unitIds: string[];
  sections: Array<{
    id: string;
    headingUnitId?: string;
    blockUnitIds: string[];
  }>;
}

export interface ValidatedSnapshotSummary {
  sha: string;
  volumeUnitIds: string[];
  chapterRefs: Array<{ volumeId: string; id: string; chapHash: string }>;
  changes: SnapshotSlotChange[];
}

export interface ValidateChaptersBatchResult {
  chapters: ValidatedChapterSummary[];
  errors: string[];
}

export interface ValidateSnapshotsBatchResult {
  snapshots: ValidatedSnapshotSummary[];
  parseErrorCount: number;
  errors: string[];
}

export interface ValidateUnitsBatchResult {
  count: number;
  unitIds: string[];
  errors: string[];
}

function walkFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

export function validateChaptersBatch(files: string[], dataDir: string): ValidateChaptersBatchResult {
  const chapters: ValidatedChapterSummary[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const rel = relative(dataDir, file).replace(/\\/g, "/");
    vlog(2, `validate chapter ${rel}`);
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const parsed = ChapterManifestSchema.parse(raw);
      const expectedSuffix = `${parsed.chap_hash}.json`;
      if (!rel.endsWith(expectedSuffix)) {
        errors.push(`Chapter path mismatch for ${rel}: expected suffix ${expectedSuffix}`);
      }
      const computedHash = verifyChapterManifestHash(parsed);
      if (computedHash !== parsed.chap_hash) {
        errors.push(
          `Chapter content hash mismatch for ${rel}: chap_hash ${parsed.chap_hash} != computed ${computedHash}`,
        );
      }
      chapters.push({
        chapHash: parsed.chap_hash,
        id: parsed.id,
        unitIds: collectChapterUnitIds(parsed),
        sections: parsed.sections.map((sec) => ({
          id: sec.id,
          ...(sec.heading_unit_id !== undefined ? { headingUnitId: sec.heading_unit_id } : {}),
          blockUnitIds: sec.blocks.map(blockEntryUnitId),
        })),
      });
    } catch (err) {
      errors.push(`Invalid chapter ${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { chapters, errors };
}

export function validateSnapshotsBatch(
  files: string[],
  dataDir: string,
): ValidateSnapshotsBatchResult {
  const snapshots: ValidatedSnapshotSummary[] = [];
  const errors: string[] = [];
  let parseErrorCount = 0;

  for (const file of files) {
    const rel = relative(dataDir, file).replace(/\\/g, "/");
    vlog(2, `validate snapshot ${rel}`);
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const parsed = SnapshotManifestSchema.parse(raw);
      const expectedSuffix = `${parsed.sha}.json`;
      if (!rel.endsWith(expectedSuffix)) {
        errors.push(`Snapshot path mismatch for ${rel}: expected suffix ${expectedSuffix}`);
      }
      const volumeUnitIds: string[] = [];
      const seenVolIds = new Set<string>();
      const chapterRefs: Array<{ volumeId: string; id: string; chapHash: string }> = [];
      for (const vol of parsed.volumes) {
        if (vol.title_unit_id && !seenVolIds.has(vol.title_unit_id)) {
          seenVolIds.add(vol.title_unit_id);
          volumeUnitIds.push(vol.title_unit_id);
        }
        for (const chap of vol.chapters) {
          chapterRefs.push({ volumeId: vol.id, id: chap.id, chapHash: chap.chap_hash });
        }
      }
      snapshots.push({
        sha: parsed.sha,
        volumeUnitIds,
        chapterRefs,
        changes: parsed.changes,
      });
    } catch (err) {
      parseErrorCount++;
      errors.push(`Invalid snapshot ${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { snapshots, parseErrorCount, errors };
}

export function validateUnitsBatch(files: string[], dataDir: string): ValidateUnitsBatchResult {
  const unitIds: string[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const rel = relative(dataDir, file).replace(/\\/g, "/");
    try {
      const content = readFileSync(file, "utf8");
      const unit = parseUnitToml(content);
      unitIds.push(unit.unit_id);
      const expectedSuffix = `${unit.unit_id.slice(0, 2)}/${unit.unit_id}.toml`;
      if (!rel.endsWith(expectedSuffix)) {
        errors.push(`Unit path mismatch for ${rel}: expected suffix ${expectedSuffix}`);
      }
      const expectedId = computeUnitId(unit.kind, unit.en);
      if (expectedId !== unit.unit_id) {
        errors.push(
          `Unit content hash mismatch for ${rel}: unit_id ${unit.unit_id} != computed ${expectedId}`,
        );
      }
      if (unit.kind === "heading") {
        if (/^=+\s+/.test(unit.en.trim())) {
          errors.push(`Heading unit ${rel} still has leading '=' markers in en`);
        }
        if (unit.translatable && /^=+\s+/.test(unit.zh.trim())) {
          errors.push(`Heading unit ${rel} has leading '=' markers in zh`);
        }
      }
      if (isVerbose(3)) vlog(3, `validate unit ${rel} (${unit.kind}) OK`);
    } catch (err) {
      errors.push(`Invalid unit ${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { count: files.length, unitIds, errors };
}

/**
 * Validates the data repository's manifests (index, content-addressed chapters, slim snapshots),
 * GLOSSARY.md, pure unit TOML invariants, and full referential integrity.
 */
export async function validateDataRepo(
  dataDir: string,
  options: ValidateDataOptions = {},
): Promise<ValidateDataResult> {
  const jobs = Math.max(1, Math.floor(options.jobs ?? defaultJobs()));
  const errors: string[] = [];
  let unitCount = 0;
  let chapterCount = 0;
  let snapshotCount = 0;

  // 1. Validate GLOSSARY.md
  const glossaryPath = join(dataDir, "GLOSSARY.md");
  if (!existsSync(glossaryPath)) {
    errors.push("Missing GLOSSARY.md");
  } else {
    const glossary = readFileSync(glossaryPath, "utf8");
    if (glossary.trim().length === 0) {
      errors.push("GLOSSARY.md is empty");
    }
  }

  // 2. Validate manifests/index.json
  const indexPath = join(dataDir, "manifests", "index.json");
  let indexedCommits: Array<{ sha: string }> = [];
  if (!existsSync(indexPath)) {
    errors.push("Missing manifests/index.json");
  } else {
    try {
      const raw = JSON.parse(readFileSync(indexPath, "utf8"));
      const parsed = ManifestIndexSchema.parse(raw);
      indexedCommits = parsed.commits;
    } catch (err) {
      errors.push(`Invalid manifests/index.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const chaptersDir = join(dataDir, "manifests", "chapters");
  const chapterFiles = walkFiles(chaptersDir, ".json");
  const snapshotsDir = join(dataDir, "manifests", "snapshots");
  const snapshotFiles = walkFiles(snapshotsDir, ".json");
  const unitsDir = join(dataDir, "units");
  const unitFiles = walkFiles(unitsDir, ".toml");

  const parallelChapters = jobs > 1 && chapterFiles.length >= MIN_PARALLEL_ITEMS;
  const parallelSnapshots = jobs > 1 && snapshotFiles.length >= MIN_PARALLEL_SNAPSHOTS;
  const parallelUnits = jobs > 1 && unitFiles.length >= MIN_PARALLEL_ITEMS;

  const chapChunks = parallelChapters
    ? chunkArray(chapterFiles, Math.max(16, Math.ceil(chapterFiles.length / (jobs * 2))))
    : [];
  const snapChunks = parallelSnapshots
    ? chunkArray(snapshotFiles, Math.max(2, Math.ceil(snapshotFiles.length / (jobs * 2))))
    : [];
  const unitChunks = parallelUnits
    ? chunkArray(unitFiles, Math.max(32, Math.ceil(unitFiles.length / (jobs * 4))))
    : [];

  const maxChunks = Math.max(chapChunks.length, snapChunks.length, unitChunks.length);
  const pool = maxChunks > 0 ? createWorkerPool(Math.min(jobs, maxChunks)) : null;

  const chaptersByHash = new Map<string, ValidatedChapterSummary>();
  const validatedSnapshots: ValidatedSnapshotSummary[] = [];
  const referencedBySnapshot = new Map<string, string[]>();
  const existingUnitIds = new Set<string>();
  let snapshotParseErrors = 0;

  try {
    // 3. Validate manifests/chapters/*.json
    vlog(1, `validate: checking ${chapterFiles.length} chapter manifest(s)`);
    chapterCount = chapterFiles.length;
    if (parallelChapters && pool) {
      const chapResults = await Promise.all(
        chapChunks.map((files) =>
          pool.run<ValidateChaptersBatchResult>({
            type: "validateChaptersBatch",
            files,
            dataDir,
          }),
        ),
      );
      for (const res of chapResults) {
        for (const ch of res.chapters) {
          chaptersByHash.set(ch.chapHash, ch);
        }
        errors.push(...res.errors);
      }
    } else {
      const res = validateChaptersBatch(chapterFiles, dataDir);
      for (const ch of res.chapters) {
        chaptersByHash.set(ch.chapHash, ch);
      }
      errors.push(...res.errors);
    }

    // 4. Validate manifests/snapshots/*.json
    vlog(1, `validate: checking ${snapshotFiles.length} snapshot(s)`);
    snapshotCount = snapshotFiles.length;
    if (parallelSnapshots && pool) {
      const snapResults = await Promise.all(
        snapChunks.map((files) =>
          pool.run<ValidateSnapshotsBatchResult>({
            type: "validateSnapshotsBatch",
            files,
            dataDir,
          }),
        ),
      );
      for (const res of snapResults) {
        validatedSnapshots.push(...res.snapshots);
        snapshotParseErrors += res.parseErrorCount;
        errors.push(...res.errors);
      }
    } else {
      const res = validateSnapshotsBatch(snapshotFiles, dataDir);
      validatedSnapshots.push(...res.snapshots);
      snapshotParseErrors += res.parseErrorCount;
      errors.push(...res.errors);
    }

    // 5. Cross-validate indexed commits, snapshots, chapters, and sparse slot changes
    const foundSnapshotShas = new Set<string>();
    const referencedChapterHashes = new Set<string>();

    for (const snap of validatedSnapshots) {
      foundSnapshotShas.add(snap.sha);
      const unitSet = new Set<string>(snap.volumeUnitIds);
      const chapByKey = new Map<string, ValidatedChapterSummary>();

      for (const ref of snap.chapterRefs) {
        const chap = chaptersByHash.get(ref.chapHash);
        if (!chap) {
          errors.push(
            `Snapshot ${snap.sha.slice(0, 10)} references missing chapter ${ref.chapHash}`,
          );
          continue;
        }
        referencedChapterHashes.add(ref.chapHash);
        if (chap.id !== ref.id) {
          errors.push(
            `Snapshot ${snap.sha.slice(0, 10)} chapter id mismatch for ${ref.volumeId}/${ref.id}: manifest ${ref.chapHash} has id ${chap.id}`,
          );
        }
        chapByKey.set(`${ref.volumeId}/${ref.id}`, chap);
        for (const uid of chap.unitIds) {
          unitSet.add(uid);
        }
      }

      for (const chg of snap.changes) {
        const chap = chapByKey.get(chg.chapter_key);
        if (!chap) {
          errors.push(
            `Snapshot ${snap.sha.slice(0, 10)} change references missing chapter ${chg.chapter_key}`,
          );
          continue;
        }
        if (chg.slot === "heading") {
          const sec =
            chap.sections.find(
              (s) => s.id === chg.section_id && s.headingUnitId === chg.unit_id,
            ) ?? chap.sections.find((s) => s.id === chg.section_id);
          if (!sec) {
            errors.push(
              `Snapshot ${snap.sha.slice(0, 10)} change references missing section ${chg.chapter_key}/${chg.section_id}`,
            );
          } else if (sec.headingUnitId !== chg.unit_id) {
            errors.push(
              `Snapshot ${snap.sha.slice(0, 10)} heading change unit_id mismatch at ${chg.chapter_key}/${chg.section_id}: expected ${chg.unit_id}, got ${sec.headingUnitId ?? "none"}`,
            );
          }
        } else {
          const idx = chg.slot;
          const sec =
            chap.sections.find(
              (s) => s.id === chg.section_id && s.blockUnitIds[idx] === chg.unit_id,
            ) ?? chap.sections.find((s) => s.id === chg.section_id);
          if (!sec) {
            errors.push(
              `Snapshot ${snap.sha.slice(0, 10)} change references missing section ${chg.chapter_key}/${chg.section_id}`,
            );
          } else if (idx >= sec.blockUnitIds.length) {
            errors.push(
              `Snapshot ${snap.sha.slice(0, 10)} change references out-of-range slot ${idx} in ${chg.chapter_key}/${chg.section_id}`,
            );
          } else if (sec.blockUnitIds[idx] !== chg.unit_id) {
            errors.push(
              `Snapshot ${snap.sha.slice(0, 10)} change unit_id mismatch at ${chg.chapter_key}/${chg.section_id}[${idx}]: expected ${chg.unit_id}, got ${sec.blockUnitIds[idx]}`,
            );
          }
        }
      }

      referencedBySnapshot.set(snap.sha, [...unitSet]);
    }

    for (const commit of indexedCommits) {
      if (!foundSnapshotShas.has(commit.sha)) {
        errors.push(`Missing snapshot manifest for indexed commit ${commit.sha}`);
      }
    }

    if (snapshotParseErrors === 0) {
      for (const chapHash of [...chaptersByHash.keys()].sort()) {
        if (!referencedChapterHashes.has(chapHash)) {
          errors.push(`Orphan chapter manifest ${chapHash}.json is not referenced by any snapshot`);
        }
      }
    }

    // 6. Validate units/**/*.toml
    vlog(1, `validate: checking ${unitFiles.length} unit(s)`);
    const unitBar = createProgress({ label: "Validating units", total: unitFiles.length });
    try {
      if (parallelUnits && pool) {
        let completed = 0;
        const unitResults = await Promise.all(
          unitChunks.map(async (files) => {
            const res = await pool.run<ValidateUnitsBatchResult>({
              type: "validateUnitsBatch",
              files,
              dataDir,
            });
            completed += res.count;
            unitBar.update(completed);
            return res;
          }),
        );
        unitCount = unitFiles.length;
        for (const res of unitResults) {
          for (const id of res.unitIds) existingUnitIds.add(id);
          errors.push(...res.errors);
        }
      } else {
        unitCount = unitFiles.length;
        const res = validateUnitsBatch(unitFiles, dataDir);
        for (const id of res.unitIds) existingUnitIds.add(id);
        errors.push(...res.errors);
        unitBar.update(unitCount);
      }
      unitBar.done();
    } finally {
      unitBar.clear();
    }

    // 7. Referential integrity: all snapshot unit_ids exist in units/
    for (const [sha, refs] of referencedBySnapshot) {
      for (const uid of refs) {
        if (!existingUnitIds.has(uid)) {
          errors.push(`Snapshot ${sha.slice(0, 10)} references missing unit ${uid}`);
        }
      }
    }
  } finally {
    if (pool) {
      await pool.close();
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    unitCount,
    chapterCount,
    snapshotCount,
  };
}
