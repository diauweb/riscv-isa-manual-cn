import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ManifestIndexSchema,
  type BlockRef,
  type ChapterManifest,
  type ChapterNode,
  type CommitIndexEntry,
  type ManifestIndex,
  type TranslatableBlockKind,
  type UnitToml,
  type UntranslatableBlockKind,
} from "@riscv-cn/schema";
import { classifyUpstreamTags, diffSnapshots, type SnapshotInput } from "../diff/index.ts";
import { isCiEnv } from "../config.ts";
import { DEFAULT_AI_CONCURRENCY, type ReasoningEffort } from "../env-keys.ts";
import { runGit, runGitOrThrow } from "../git.ts";
import {
  collectChapterUnitIds,
  readChapterManifest,
  readHydratedSnapshot,
  readSnapshotManifestRaw,
  snapshotManifestPath,
  writeHydratedSnapshot,
  writeSnapshotManifestRaw,
  type HydratedSnapshot,
} from "../manifests/index.ts";
import {
  FALLBACK_GLOBAL_CONFIG_ADOC,
  parseRepositorySnapshot,
  type ExtractedUnit,
} from "../parser/index.ts";
import { parseUnitToml, serializeUnitToml, unitRelPath } from "../toml/index.ts";
import { IMAGE_EXT_RE } from "../resources.ts";
import { error, info, isVerbose, vlog, type Logger } from "../log.ts";
import {
  createWorkerPool,
  defaultJobs,
  loadUnitsParallel,
  MIN_PARALLEL_ITEMS,
  type WorkerPool,
} from "../parallel/index.ts";
import {
  createProgress,
  createTranslateProgress,
  formatDuration,
  formatLlmProgress,
  type LlmProgressSnapshot,
  type ProgressStream,
} from "../progress.ts";
import {
  translateChapterBatch,
  type ChapterContextBlock,
  type TranslationTarget,
} from "../translate/index.ts";

export interface RunSyncOptions {
  upstreamUrlOrPath: string;
  dataDir: string;
  maxMinutes?: number;
  maxBatches?: number;
  baselineDate?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  reasoningEffort?: ReasoningEffort | string;
  llmConcurrency?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  commitChanges?: boolean;
  failFast?: boolean;
  jobs?: number;
  progressStream?: ProgressStream;
  log?: Logger;
}

export interface RunSyncResult {
  processedCommits: number;
  translatedUnits: number;
  hasRemaining: boolean;
  failedPages?: number;
}

function recordsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i] || a[keysA[i]] !== b[keysB[i]]) return false;
  }
  return true;
}

function sortRecord(rec: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(rec).sort()) {
    out[key] = rec[key];
  }
  return out;
}

interface RemoteInfo {
  headSha: string | null;
  knownTags: Record<string, string>;
}

function inspectRemote(upstreamUrlOrPath: string): RemoteInfo {
  const output = runGitOrThrow(["ls-remote", upstreamUrlOrPath]);
  let headSha: string | null = null;
  let mainSha: string | null = null;
  let masterSha: string | null = null;
  const rawTags = new Map<string, string>();
  const peeledTags = new Map<string, string>();
  const releaseBranches = new Map<string, string>();

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [sha, ref] = trimmed.split(/\s+/);
    if (!sha || !ref) continue;
    if (ref === "HEAD") {
      headSha = sha;
    } else if (ref === "refs/heads/main") {
      mainSha = sha;
    } else if (ref === "refs/heads/master") {
      masterSha = sha;
    } else if (ref.startsWith("refs/heads/")) {
      const branchName = ref.slice("refs/heads/".length);
      const releaseMatch = /^v(\d{8})$/.exec(branchName);
      if (releaseMatch) {
        releaseBranches.set(releaseMatch[1], sha);
      }
    } else if (ref.startsWith("refs/remotes/")) {
      const remoteMatch = /^refs\/remotes\/[^/]+\/v(\d{8})$/.exec(ref);
      if (remoteMatch && !releaseBranches.has(remoteMatch[1])) {
        releaseBranches.set(remoteMatch[1], sha);
      }
    } else if (ref.startsWith("refs/tags/")) {
      const tagRest = ref.slice("refs/tags/".length);
      if (tagRest.endsWith("^{}")) {
        const tagName = tagRest.slice(0, -3);
        peeledTags.set(tagName, sha);
      } else {
        rawTags.set(tagRest, sha);
      }
    }
  }

  const knownTagsRaw: Record<string, string> = {};
  for (const [tag, rawSha] of rawTags) {
    if (/^\d{8}$/.test(tag) || /^riscv-isa-release-/.test(tag)) {
      knownTagsRaw[tag] = peeledTags.get(tag) ?? rawSha;
    }
  }
  for (const [version, branchSha] of releaseBranches) {
    if (!(version in knownTagsRaw)) {
      knownTagsRaw[version] = branchSha;
    }
  }

  return {
    headSha: headSha ?? mainSha ?? masterSha,
    knownTags: sortRecord(knownTagsRaw),
  };
}

function writeManifestIndex(dataDir: string, index: ManifestIndex): void {
  const path = join(dataDir, "manifests", "index.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ManifestIndexSchema.parse(index), null, 2)}\n`, "utf8");
}

function writeUnitToml(dataDir: string, unit: UnitToml): void {
  const fullPath = join(dataDir, unitRelPath(unit.unit_id));
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, serializeUnitToml(unit), "utf8");
}

function walkTomlFiles(dir: string): string[] {
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
      } else if (entry.isFile() && entry.name.endsWith(".toml")) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function isUnitTranslated(unit: UnitToml): boolean {
  return unit.translatable ? unit.status !== "untranslated" : true;
}

interface ScannedUnitsState {
  onDiskUnitIds: Set<string>;
  translatedUnitIds: Set<string>;
  stubUnitsById: Map<string, UnitToml>;
  unitCache: Map<string, UnitToml | null>;
}

async function scanUnitStates(dataDir: string, jobs: number): Promise<ScannedUnitsState> {
  const onDiskUnitIds = new Set<string>();
  const translatedUnitIds = new Set<string>();
  const stubUnitsById = new Map<string, UnitToml>();
  const unitCache = new Map<string, UnitToml | null>();
  const unitFiles = walkTomlFiles(join(dataDir, "units"));
  if (unitFiles.length === 0) {
    return { onDiskUnitIds, translatedUnitIds, stubUnitsById, unitCache };
  }
  const units = await loadUnitsParallel(unitFiles, jobs);
  for (const unit of units) {
    onDiskUnitIds.add(unit.unit_id);
    unitCache.set(unit.unit_id, unit);
    if (isUnitTranslated(unit)) {
      translatedUnitIds.add(unit.unit_id);
    } else {
      stubUnitsById.set(unit.unit_id, unit);
    }
  }
  return { onDiskUnitIds, translatedUnitIds, stubUnitsById, unitCache };
}

function recordSnapshotMissingAndPrev(
  snap: HydratedSnapshot,
  existingUnitIds: Set<string>,
  missingBySnapshot: Map<string, Set<string>>,
  allMissingIds: Set<string>,
  prevUnitById: Map<string, string>,
): void {
  let snapMissing = missingBySnapshot.get(snap.sha);
  const addMissing = (unitId: string) => {
    if (existingUnitIds.has(unitId)) return;
    if (!snapMissing) {
      snapMissing = new Set<string>();
      missingBySnapshot.set(snap.sha, snapMissing);
    }
    snapMissing.add(unitId);
    allMissingIds.add(unitId);
  };

  for (const vol of snap.volumes) {
    if (vol.title_unit_id) {
      addMissing(vol.title_unit_id);
      if (vol.title_prev_unit_id && !prevUnitById.has(vol.title_unit_id)) {
        prevUnitById.set(vol.title_unit_id, vol.title_prev_unit_id);
      }
    }
    for (const chap of vol.chapters) {
      if (chap.title_unit_id) addMissing(chap.title_unit_id);
      for (const sec of chap.sections) {
        if (sec.heading_unit_id) {
          addMissing(sec.heading_unit_id);
          if (sec.heading_prev_unit_id && !prevUnitById.has(sec.heading_unit_id)) {
            prevUnitById.set(sec.heading_unit_id, sec.heading_prev_unit_id);
          }
        }
        for (const b of sec.blocks) {
          addMissing(b.unit_id);
          if (b.prev_unit_id && !prevUnitById.has(b.unit_id)) {
            prevUnitById.set(b.unit_id, b.prev_unit_id);
          }
        }
      }
    }
  }
}

function scanSnapshotMetadata(
  dataDir: string,
  commits: CommitIndexEntry[],
  existingUnitIds: Set<string>,
  chapterCache: Map<string, ChapterManifest>,
): {
  missingBySnapshot: Map<string, Set<string>>;
  allMissingIds: Set<string>;
  prevUnitById: Map<string, string>;
} {
  const missingBySnapshot = new Map<string, Set<string>>();
  const allMissingIds = new Set<string>();
  const prevUnitById = new Map<string, string>();
  const chapterUnitIdsCache = new Map<string, string[]>();

  for (const entry of commits) {
    const snapPath = snapshotManifestPath(dataDir, entry.sha);
    if (!existsSync(snapPath)) continue;
    const snap = readSnapshotManifestRaw(dataDir, entry.sha);

    let snapMissing = missingBySnapshot.get(snap.sha);
    const addMissing = (unitId: string) => {
      if (existingUnitIds.has(unitId)) return;
      if (!snapMissing) {
        snapMissing = new Set<string>();
        missingBySnapshot.set(snap.sha, snapMissing);
      }
      snapMissing.add(unitId);
      allMissingIds.add(unitId);
    };

    for (const vol of snap.volumes) {
      if (vol.title_unit_id) {
        addMissing(vol.title_unit_id);
        if (vol.title_prev_unit_id && !prevUnitById.has(vol.title_unit_id)) {
          prevUnitById.set(vol.title_unit_id, vol.title_prev_unit_id);
        }
      }
      for (const chapRef of vol.chapters) {
        let unitIds = chapterUnitIdsCache.get(chapRef.chap_hash);
        if (!unitIds) {
          const chapManifest = readChapterManifest(dataDir, chapRef.chap_hash, chapterCache);
          unitIds = collectChapterUnitIds(chapManifest);
          chapterUnitIdsCache.set(chapRef.chap_hash, unitIds);
        }
        for (const uid of unitIds) {
          addMissing(uid);
        }
      }
    }

    for (const chg of snap.changes) {
      if (chg.prev_unit_id && !prevUnitById.has(chg.unit_id)) {
        prevUnitById.set(chg.unit_id, chg.prev_unit_id);
      }
    }
  }
  return { missingBySnapshot, allMissingIds, prevUnitById };
}

async function reconstructSnapshotInput(
  sha: string,
  dataDir: string,
  existingUnitIds: Set<string>,
  loadUnit: (unitId: string) => UnitToml | null,
  unitCache: Map<string, UnitToml | null>,
  chapterCache: Map<string, ChapterManifest>,
  jobs: number,
): Promise<SnapshotInput | null> {
  const snap = readHydratedSnapshot(dataDir, sha, chapterCache);
  const referencedIds: string[] = [];
  const seenRef = new Set<string>();
  const addRef = (unitId: string): boolean => {
    if (seenRef.has(unitId)) return true;
    if (!existingUnitIds.has(unitId)) return false;
    seenRef.add(unitId);
    referencedIds.push(unitId);
    return true;
  };

  for (const vol of snap.volumes) {
    if (vol.title_unit_id && !addRef(vol.title_unit_id)) return null;
    for (const chap of vol.chapters) {
      if (chap.title_unit_id && !addRef(chap.title_unit_id)) return null;
      for (const sec of chap.sections) {
        if (sec.heading_unit_id && !addRef(sec.heading_unit_id)) return null;
        for (const b of sec.blocks) {
          if (!addRef(b.unit_id)) return null;
        }
      }
    }
  }

  const uncachedIds = referencedIds.filter((id) => !unitCache.has(id));
  if (jobs > 1 && uncachedIds.length >= MIN_PARALLEL_ITEMS) {
    try {
      const loadedUnits = await loadUnitsParallel(
        uncachedIds.map((id) => join(dataDir, unitRelPath(id))),
        jobs,
      );
      for (const unit of loadedUnits) {
        unitCache.set(unit.unit_id, unit);
      }
    } catch {
      return null;
    }
  }

  const units = new Map<string, ExtractedUnit>();
  for (const unitId of referencedIds) {
    const unit = loadUnit(unitId);
    if (!unit) return null;
    units.set(unitId, {
      unit_id: unit.unit_id,
      kind: unit.kind,
      translatable: unit.translatable,
      en: unit.en,
    });
  }
  return { volumes: snap.volumes, units };
}

function isGitRepo(dir: string): boolean {
  const res = runGit(["rev-parse", "--is-inside-work-tree"], dir);
  return res.exitCode === 0 && res.stdout.trim() === "true";
}

function gitCommitIfDirty(dataDir: string, message: string): boolean {
  if (!isGitRepo(dataDir)) return false;
  const status = runGitOrThrow(["status", "--porcelain"], dataDir);
  if (status.trim().length === 0) return false;
  runGitOrThrow(["add", "-A"], dataDir);
  runGitOrThrow(["commit", "-m", message], dataDir);
  return true;
}

function resolveMainBranch(tmpRepo: string): string {
  for (const candidate of ["refs/heads/main", "refs/heads/master", "HEAD"]) {
    const check = runGit(["rev-parse", "--verify", candidate], tmpRepo);
    if (check.exitCode === 0) return candidate;
  }
  return "HEAD";
}

/**
 * Resolve ratified release refs (`YYYYMMDD` from `refs/tags/YYYYMMDD` or `refs/heads/vYYYYMMDD`)
 * onto their corresponding `--first-parent` anchor commit on the main branch.
 */
function resolveAnchorTagEntries(
  repo: string,
  branchRef: string,
  knownTags: Record<string, string>,
): Array<{ tag: string; sha: string }> {
  const entries = Object.entries(knownTags);
  const hasRatified = entries.some(([tag]) => /^\d{8}$/.test(tag));
  if (!hasRatified) {
    return entries.map(([tag, sha]) => ({ tag, sha }));
  }

  const firstParentList = runGitOrThrow(["rev-list", "--first-parent", branchRef], repo);
  const firstParentSet = new Set(
    firstParentList
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const resolveFirstParentAnchor = (sha: string): string => {
    if (firstParentSet.has(sha)) return sha;
    if (runGit(["cat-file", "-e", `${sha}^{commit}`], repo).exitCode !== 0) return sha;
    const mb = runGit(["merge-base", branchRef, sha], repo);
    if (mb.exitCode !== 0) return sha;
    const base = mb.stdout.trim();
    if (!base) return sha;
    if (firstParentSet.has(base)) return base;

    const anc = runGit(
      ["rev-list", "--first-parent", "--ancestry-path", "--reverse", `${base}..${branchRef}`],
      repo,
    );
    if (anc.exitCode !== 0) return sha;
    const firstMerge = anc.stdout
      .split("\n")
      .map((s) => s.trim())
      .find(Boolean);
    return firstMerge ?? sha;
  };

  return entries.map(([tag, sha]) => ({
    tag,
    sha: /^\d{8}$/.test(tag) ? resolveFirstParentAnchor(sha) : sha,
  }));
}

function resolveGlobalConfigContent(upstreamUrlOrPath: string, tmpRepo: string): string {
  const localGlobalConfig = join(upstreamUrlOrPath, "docs-resources", "global-config.adoc");
  if (existsSync(localGlobalConfig)) {
    return readFileSync(localGlobalConfig, "utf8");
  }

  if (existsSync(join(tmpRepo, ".gitmodules"))) {
    runGit(
      ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--depth", "1", "docs-resources"],
      tmpRepo,
    );
    const clonedGlobalConfig = join(tmpRepo, "docs-resources", "global-config.adoc");
    if (existsSync(clonedGlobalConfig)) {
      return readFileSync(clonedGlobalConfig, "utf8");
    }
  }

  return FALLBACK_GLOBAL_CONFIG_ADOC;
}

function ensureDocsResources(tmpRepo: string, globalConfigContent: string): void {
  const targetPath = join(tmpRepo, "docs-resources", "global-config.adoc");
  if (!existsSync(targetPath)) {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, globalConfigContent, "utf8");
  }
}

/**
 * Synchronizes upstream RISC-V ISA manual commits, generates snapshot manifests and
 * structural diffs, translates new/modified units chapter-by-chapter, and checkpoints
 * changes to Git within optional maxMinutes time budgets.
 */
export async function runSync(options: RunSyncOptions): Promise<RunSyncResult> {
  const startMs = Date.now();
  const commitChanges = options.commitChanges !== false;
  const failFast = options.failFast ?? isCiEnv();
  const logPhase = (msg: string) => {
    if (isCiEnv()) info(msg, options.log);
    else vlog(1, msg, options.log);
  };
  if (
    options.llmConcurrency !== undefined &&
    (!Number.isInteger(options.llmConcurrency) || options.llmConcurrency <= 0)
  ) {
    throw new Error(`Invalid llmConcurrency value: ${options.llmConcurrency}`);
  }
  const llmConcurrency = options.llmConcurrency ?? DEFAULT_AI_CONCURRENCY;
  const jobs = Math.max(1, Math.floor(options.jobs ?? defaultJobs()));
  const indexPath = join(options.dataDir, "manifests", "index.json");
  const glossaryPath = join(options.dataDir, "GLOSSARY.md");

  if (!existsSync(indexPath)) {
    throw new Error(`Missing manifests/index.json in ${options.dataDir}`);
  }
  if (!existsSync(glossaryPath)) {
    throw new Error(`Missing GLOSSARY.md in ${options.dataDir}`);
  }

  const manifestIndex = ManifestIndexSchema.parse(JSON.parse(readFileSync(indexPath, "utf8")));
  const glossaryMarkdown = readFileSync(glossaryPath, "utf8");
  const baselineDate = options.baselineDate ?? manifestIndex.baseline_cutoff ?? "2023-06-01";

  vlog(1, `sync: inspecting remote ${options.upstreamUrlOrPath}`);
  const remote = inspectRemote(options.upstreamUrlOrPath);
  if (!remote.headSha) {
    vlog(1, "sync: remote has no HEAD; nothing to do");
    return { processedCommits: 0, translatedUnits: 0, hasRemaining: false };
  }

  const tagsMatch = recordsEqual(manifestIndex.known_tags, remote.knownTags);
  const shaMatch = manifestIndex.last_synced_sha === remote.headSha;
  const chapterCache = new Map<string, ChapterManifest>();
  const writtenChapterHashes = new Set<string>();
  const { onDiskUnitIds, translatedUnitIds, stubUnitsById, unitCache } = await scanUnitStates(
    options.dataDir,
    jobs,
  );
  const { missingBySnapshot, allMissingIds, prevUnitById } = scanSnapshotMetadata(
    options.dataDir,
    manifestIndex.commits,
    translatedUnitIds,
    chapterCache,
  );
  vlog(
    1,
    `sync: remoteHead=${remote.headSha.slice(0, 8)}, shaMatch=${shaMatch}, tagsMatch=${tagsMatch}, missingSnapshots=${missingBySnapshot.size}`,
  );

  if (shaMatch && tagsMatch && allMissingIds.size === 0) {
    return { processedCommits: 0, translatedUnits: 0, hasRemaining: false };
  }

  const loadUnit = (unitId: string): UnitToml | null => {
    if (unitCache.has(unitId)) return unitCache.get(unitId)!;
    if (!onDiskUnitIds.has(unitId)) {
      unitCache.set(unitId, null);
      return null;
    }
    const fullPath = join(options.dataDir, unitRelPath(unitId));
    if (!existsSync(fullPath)) {
      unitCache.set(unitId, null);
      return null;
    }
    const parsed = parseUnitToml(readFileSync(fullPath, "utf8"));
    unitCache.set(unitId, parsed);
    return parsed;
  };
  const saveStubUnit = (unit: UnitToml): void => {
    writeUnitToml(options.dataDir, unit);
    onDiskUnitIds.add(unit.unit_id);
    unitCache.set(unit.unit_id, unit);
  };
  const saveTranslatedUnit = (unit: UnitToml): void => {
    writeUnitToml(options.dataDir, unit);
    onDiskUnitIds.add(unit.unit_id);
    translatedUnitIds.add(unit.unit_id);
    unitCache.set(unit.unit_id, unit);
    allMissingIds.delete(unit.unit_id);
  };

  let tmpRepo: string | null = null;
  let globalConfigContent = FALLBACK_GLOBAL_CONFIG_ADOC;
  let tmpWorktreesDir: string | null = null;
  let snapshotPool: WorkerPool | null = null;
  const worktreeDirs: string[] = [];

  const ensureTmpRepo = (): string => {
    if (tmpRepo) return tmpRepo;
    tmpRepo = mkdtempSync(join(tmpdir(), "riscv-upstream-"));
    vlog(1, `sync: cloning upstream into ${tmpRepo}`);
    runGitOrThrow(["clone", "--quiet", options.upstreamUrlOrPath, tmpRepo]);
    globalConfigContent = resolveGlobalConfigContent(options.upstreamUrlOrPath, tmpRepo);
    return tmpRepo;
  };

  const ensureSnapshotPool = (desiredWorkers: number, initialRef: string): WorkerPool => {
    if (snapshotPool) return snapshotPool;
    const repo = ensureTmpRepo();
    tmpWorktreesDir = mkdtempSync(join(tmpdir(), "riscv-worktrees-"));
    for (let i = 0; i < desiredWorkers; i++) {
      const wtDir = join(tmpWorktreesDir, `w${i}`);
      runGitOrThrow(
        ["worktree", "add", "--quiet", "--detach", "--no-checkout", wtDir, initialRef],
        repo,
      );
      worktreeDirs.push(wtDir);
    }
    snapshotPool = createWorkerPool(desiredWorkers);
    return snapshotPool;
  };

  const parseSnapshotInPool = (pool: WorkerPool, sha: string): Promise<SnapshotInput> =>
    pool.run<SnapshotInput>((workerIdx) => ({
      type: "parseSnapshot",
      worktreeDir: worktreeDirs[workerIdx],
      sha,
      globalConfigContent,
    }));

  const parseSnapshotInline = (sha: string): SnapshotInput => {
    const repo = ensureTmpRepo();
    runGitOrThrow(["checkout", "--force", "--quiet", sha], repo);
    ensureDocsResources(repo, globalConfigContent);
    return parseRepositorySnapshot(repo);
  };

  let processedCommits = 0;
  let translatedUnits = 0;
  const extractedUnitsById = new Map<string, ExtractedUnit>();
  for (const [unitId, stub] of stubUnitsById) {
    extractedUnitsById.set(unitId, {
      unit_id: stub.unit_id,
      kind: stub.kind,
      translatable: stub.translatable,
      en: stub.en,
    });
  }
  const persistExtractedUnitStub = (unit: ExtractedUnit): void => {
    extractedUnitsById.set(unit.unit_id, unit);
    if (onDiskUnitIds.has(unit.unit_id)) return;
    if (unit.translatable) {
      if (isVerbose(3)) vlog(3, `unit ${unit.unit_id} (${unit.kind}, untranslated stub)`);
      saveStubUnit({
        unit_id: unit.unit_id,
        kind: unit.kind as TranslatableBlockKind,
        translatable: true,
        status: "untranslated",
        en: unit.en,
        zh: "",
      });
    } else {
      if (isVerbose(3)) vlog(3, `unit ${unit.unit_id} (${unit.kind}, non-translatable stub)`);
      saveTranslatedUnit({
        unit_id: unit.unit_id,
        kind: unit.kind as UntranslatableBlockKind,
        translatable: false,
        en: unit.en,
      });
    }
  };
  let syncFailed = false;

  try {
    const knownCommitShas = new Set(manifestIndex.commits.map((c) => c.sha));
    const needsRepoForTags =
      !shaMatch ||
      (!tagsMatch &&
        manifestIndex.commits.length > 0 &&
        Object.entries(remote.knownTags).some(
          ([tag, sha]) => /^\d{8}$/.test(tag) && !knownCommitShas.has(sha),
        ));
    const tagEntries = needsRepoForTags
      ? (() => {
          const repo = ensureTmpRepo();
          return resolveAnchorTagEntries(repo, resolveMainBranch(repo), remote.knownTags);
        })()
      : Object.entries(remote.knownTags).map(([tag, sha]) => ({ tag, sha }));
    const tagMap = classifyUpstreamTags(tagEntries);

    if (!tagsMatch && manifestIndex.commits.length > 0) {
      for (const commit of manifestIndex.commits) {
        const info = tagMap.get(commit.sha) ?? { ratified_tag: null, draft_tags: [] };
        if (
          commit.ratified_tag !== info.ratified_tag ||
          JSON.stringify(commit.draft_tags) !== JSON.stringify(info.draft_tags)
        ) {
          commit.ratified_tag = info.ratified_tag;
          commit.draft_tags = info.draft_tags;
          const snapPath = snapshotManifestPath(options.dataDir, commit.sha);
          if (existsSync(snapPath)) {
            const snap = readSnapshotManifestRaw(options.dataDir, commit.sha);
            snap.ratified_tag = info.ratified_tag;
            snap.draft_tags = info.draft_tags;
            writeSnapshotManifestRaw(options.dataDir, snap);
          }
        }
      }
      manifestIndex.known_tags = remote.knownTags;
      writeManifestIndex(options.dataDir, manifestIndex);
    }

    if (shaMatch && allMissingIds.size === 0) {
      if (commitChanges) {
        gitCommitIfDirty(options.dataDir, "chore(sync): update upstream tag metadata");
      }
      return { processedCommits: 0, translatedUnits: 0, hasRemaining: false };
    }

    // 1. Walk any new commits since last_synced_sha
    if (!shaMatch) {
      const repo = ensureTmpRepo();
      const branchRef = resolveMainBranch(repo);
      let rangeSpec = branchRef;
      let parentSha: string | null = null;
      let parentSnapshot: SnapshotInput | null = null;

      if (manifestIndex.last_synced_sha) {
        const hasLast = runGit(
          ["cat-file", "-e", `${manifestIndex.last_synced_sha}^{commit}`],
          repo,
        );
        if (hasLast.exitCode === 0) {
          rangeSpec = `${manifestIndex.last_synced_sha}..${branchRef}`;
          parentSha = manifestIndex.last_synced_sha;
          const parentSnapPath = snapshotManifestPath(options.dataDir, parentSha);
          if (existsSync(parentSnapPath)) {
            parentSnapshot = await reconstructSnapshotInput(
              parentSha,
              options.dataDir,
              onDiskUnitIds,
              loadUnit,
              unitCache,
              chapterCache,
              jobs,
            );
          }
          if (!parentSnapshot) {
            runGitOrThrow(["checkout", "--force", "--quiet", parentSha], repo);
            ensureDocsResources(repo, globalConfigContent);
            parentSnapshot = parseRepositorySnapshot(repo);
          }
        } else {
          // Re-walking from the beginning would append duplicate/unrelated commits to the
          // manifest. This almost always means DATA_DIR is paired with the wrong upstream
          // (e.g. a real data clone with the offline fixture).
          throw new Error(
            `last_synced_sha ${manifestIndex.last_synced_sha} was not found in upstream ${options.upstreamUrlOrPath}. ` +
              "DATA_DIR and UPSTREAM_REPO do not belong together (check your config).",
          );
        }
      }

      const logOut = runGitOrThrow(
        [
          "log",
          "--first-parent",
          "-m",
          "--root",
          "--reverse",
          "--format=COMMIT%x00%H%x00%cI%x00%s",
          "--name-only",
          rangeSpec,
        ],
        repo,
      );

      const candidateMap = new Map<
        string,
        { sha: string; date: string; title: string; touchesSpec: boolean }
      >();
      let currentCandidate:
        | { sha: string; date: string; title: string; touchesSpec: boolean }
        | null = null;

      for (const rawLine of logOut.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith("COMMIT\0")) {
          const [, sha, date, ...titleParts] = line.split("\0");
          const title = titleParts.join("\0");
          if (!sha || !date || (!parentSha && date.slice(0, 10) < baselineDate)) {
            currentCandidate = null;
            continue;
          }
          currentCandidate = candidateMap.get(sha) ?? {
            sha,
            date,
            title,
            touchesSpec: false,
          };
          candidateMap.set(sha, currentCandidate);
          continue;
        }
        if (
          currentCandidate &&
          (line.endsWith(".adoc") ||
            line.endsWith(".json") ||
            line.endsWith(".wavedrom") ||
            IMAGE_EXT_RE.test(line))
        ) {
          currentCandidate.touchesSpec = true;
        }
      }

      const candidateCommits = [...candidateMap.values()];
      // Filter commits touching spec files (always keep tagged commits, HEAD, and initial commit)
      const commitsToProcess = candidateCommits.filter(
        (c, idx) =>
          (!parentSha && idx === 0) ||
          c.sha === remote.headSha ||
          tagMap.has(c.sha) ||
          c.touchesSpec,
      );

      const commitCountMsg = `sync: ${commitsToProcess.length} commit(s) to process (${candidateCommits.length} candidate(s))`;
      if (commitsToProcess.length > 0) logPhase(commitCountMsg);
      else vlog(1, commitCountMsg);
      const commitBar = createProgress({
        label: "Parsing commits",
        total: commitsToProcess.length,
        ...(options.progressStream ? { enabled: true, stream: options.progressStream } : {}),
      });
      let indexDirty = false;
      try {
        const parseWorkers =
          jobs > 1 && commitsToProcess.length > 1 ? Math.min(jobs, commitsToProcess.length) : 1;
        const pool =
          parseWorkers > 1
            ? ensureSnapshotPool(parseWorkers, commitsToProcess[0].sha)
            : null;
        const maxWindow = parseWorkers * 2;
        let nextDispatch = 0;
        const inFlight = new Map<number, Promise<SnapshotInput>>();

        const fillWindow = () => {
          if (!pool) return;
          while (nextDispatch < commitsToProcess.length && inFlight.size < maxWindow) {
            const dispatchIdx = nextDispatch++;
            const p = parseSnapshotInPool(pool, commitsToProcess[dispatchIdx].sha);
            p.catch(() => {});
            inFlight.set(dispatchIdx, p);
          }
        };

        fillWindow();

        for (let idx = 0; idx < commitsToProcess.length; idx++) {
          const commit = commitsToProcess[idx];
          vlog(
            2,
            `commit ${processedCommits + 1}/${commitsToProcess.length}: ${commit.sha.slice(0, 8)} "${commit.title}"`,
          );
          commitBar.update(processedCommits, `${commit.sha.slice(0, 8)} ${commit.title}`);

          let currentSnapshot: SnapshotInput;
          if (pool) {
            const p = inFlight.get(idx)!;
            inFlight.delete(idx);
            fillWindow();
            currentSnapshot = await p;
          } else {
            currentSnapshot = parseSnapshotInline(commit.sha);
          }

          const { volumes, is_baseline, diff, deleted_blocks, prevUnitMap } = diffSnapshots(
            parentSnapshot,
            currentSnapshot,
          );

          for (const [unitId, prevId] of prevUnitMap) {
            if (!prevUnitById.has(unitId)) prevUnitById.set(unitId, prevId);
          }

          for (const [, unit] of currentSnapshot.units) {
            persistExtractedUnitStub(unit);
          }

          const tagInfo = tagMap.get(commit.sha) ?? { ratified_tag: null, draft_tags: [] };
          const hydratedSnapshot: HydratedSnapshot = {
            sha: commit.sha,
            parent_sha: parentSha,
            is_baseline,
            date: commit.date,
            title: commit.title,
            ratified_tag: tagInfo.ratified_tag,
            draft_tags: tagInfo.draft_tags,
            diff,
            deleted_blocks,
            volumes,
          };
          writeHydratedSnapshot(
            options.dataDir,
            hydratedSnapshot,
            writtenChapterHashes,
            chapterCache,
          );
          recordSnapshotMissingAndPrev(
            hydratedSnapshot,
            translatedUnitIds,
            missingBySnapshot,
            allMissingIds,
            prevUnitById,
          );

          manifestIndex.commits.push({
            sha: commit.sha,
            parent_sha: parentSha,
            is_baseline,
            date: commit.date,
            title: commit.title,
            ratified_tag: tagInfo.ratified_tag,
            draft_tags: tagInfo.draft_tags,
            diff,
          });
          manifestIndex.last_synced_sha = commit.sha;
          manifestIndex.known_tags = remote.knownTags;
          indexDirty = true;

          parentSnapshot = currentSnapshot;
          parentSha = commit.sha;
          processedCommits++;
          commitBar.update(processedCommits, `${commit.sha.slice(0, 8)} ${commit.title}`);
        }
        commitBar.done();

        // If HEAD wasn't among processed commits (e.g. only non-spec commits), still record HEAD as last_synced_sha
        if (manifestIndex.last_synced_sha !== remote.headSha) {
          manifestIndex.last_synced_sha = remote.headSha;
          manifestIndex.known_tags = remote.knownTags;
          indexDirty = true;
        }
      } catch (err) {
        commitBar.clear();
        throw err;
      } finally {
        if (indexDirty) {
          writeManifestIndex(options.dataDir, manifestIndex);
        }
      }
    }

    // 2. Build prioritized translation queue:
    //    Tier 1: HEAD + latest ratified tag
    //    Tier 2: earlier ratified tags
    //    Tier 3: intermediate commit deltas
    const allCommits = manifestIndex.commits;
    const headCommitSha = allCommits.length > 0 ? allCommits[allCommits.length - 1].sha : null;
    const ratifiedShas = allCommits.filter((c) => c.ratified_tag !== null).map((c) => c.sha);
    const latestRatifiedSha = ratifiedShas.length > 0 ? ratifiedShas[ratifiedShas.length - 1] : null;
    const earlierRatifiedShas = ratifiedShas.slice(0, -1).reverse();

    const orderedShas: string[] = [];
    const seenShas = new Set<string>();
    const addSha = (sha: string | null) => {
      if (sha && !seenShas.has(sha)) {
        seenShas.add(sha);
        orderedShas.push(sha);
      }
    };

    addSha(headCommitSha);
    addSha(latestRatifiedSha);
    for (const sha of earlierRatifiedShas) addSha(sha);
    for (let i = allCommits.length - 1; i >= 0; i--) addSha(allCommits[i].sha);

    let completedBatches = 0;
    const isTimeBudgetExceeded = () =>
      options.maxMinutes !== undefined && (Date.now() - startMs) / 60000 >= options.maxMinutes;
    const isBudgetExceeded = () =>
      isTimeBudgetExceeded() ||
      (options.maxBatches !== undefined && completedBatches >= options.maxBatches);

    let pendingTotal = 0;
    for (const id of allMissingIds) {
      if (extractedUnitsById.get(id)?.translatable !== false) {
        pendingTotal++;
      }
    }

    const pendingMsg = `sync: ${pendingTotal} pending unit(s) across ${orderedShas.length} snapshot(s)`;
    if (pendingTotal > 0) logPhase(pendingMsg);
    else vlog(1, pendingMsg);
    const translateBar = createTranslateProgress({
      label: "Translating",
      total: pendingTotal,
      concurrency: llmConcurrency,
      ...(options.progressStream ? { enabled: true, stream: options.progressStream } : {}),
    });
    let budgetReached = false;
    let totalInputTokens = 0;
    let allInputExact = true;
    let totalOutputTokens = 0;
    let allOutputExact = true;
    let totalTimedOutputTokens = 0;
    let totalGenMs = 0;
    let hasCompletedLlmCall = false;

    const formatCumulativeSummary = () => {
      const avgTokPerSec =
        totalGenMs >= 20 && totalTimedOutputTokens > 0
          ? totalTimedOutputTokens / (totalGenMs / 1000)
          : undefined;
      return formatLlmProgress({
        phase: "finish",
        inputTokens: totalInputTokens,
        exactInput: allInputExact,
        outputTokens: totalOutputTokens,
        exactOutput: allOutputExact,
        tokPerSec: avgTokPerSec,
      });
    };

    const coveredUnitIds = new Set<string>(onDiskUnitIds);
    for (const id of extractedUnitsById.keys()) {
      coveredUnitIds.add(id);
    }
    const recoverableShas: string[] = [];
    for (const sha of orderedShas) {
      const missingInSnap = missingBySnapshot.get(sha);
      if (!missingInSnap) continue;
      let hasUncovered = false;
      for (const id of missingInSnap) {
        if (!coveredUnitIds.has(id)) {
          hasUncovered = true;
          break;
        }
      }
      if (hasUncovered) {
        recoverableShas.push(sha);
        for (const id of missingInSnap) {
          coveredUnitIds.add(id);
        }
      }
    }

    const useRecoveryPool =
      jobs > 1 &&
      (recoverableShas.length > 1 || (snapshotPool !== null && recoverableShas.length > 0));
    const recoveryWindow =
      options.maxBatches !== undefined
        ? Math.min(2, jobs)
        : Math.min(recoverableShas.length, jobs * 2);
    let nextRecIdx = 0;
    const recoveryInFlight = new Map<string, Promise<SnapshotInput>>();

    const pumpRecovery = () => {
      if (!useRecoveryPool || recoverableShas.length === 0) return;
      const pool = ensureSnapshotPool(
        Math.min(jobs, Math.max(1, recoverableShas.length)),
        recoverableShas[0],
      );
      while (
        nextRecIdx < recoverableShas.length &&
        recoveryInFlight.size < recoveryWindow &&
        !isBudgetExceeded()
      ) {
        const recSha = recoverableShas[nextRecIdx++];
        const p = parseSnapshotInPool(pool, recSha);
        p.catch(() => {});
        recoveryInFlight.set(recSha, p);
      }
    };

    const failedUnitIds = new Set<string>();
    let failedPages = 0;
    let completedPagesAcrossSnapshots = 0;
    let knownTotalPages = 0;

    try {
      snapshotLoop: for (const sha of orderedShas) {
        if (allMissingIds.size === 0) break;
        const missingInSnap = missingBySnapshot.get(sha);
        if (!missingInSnap) continue;

        let needsAnyInSnap = false;
        let needsRecovery = false;
        for (const id of missingInSnap) {
          if (!translatedUnitIds.has(id) && !failedUnitIds.has(id)) {
            needsAnyInSnap = true;
            if (!extractedUnitsById.has(id)) {
              needsRecovery = true;
              break;
            }
          }
        }
        if (!needsAnyInSnap) continue;

        if (isBudgetExceeded()) {
          budgetReached = true;
          break snapshotLoop;
        }

        if (needsRecovery) {
          vlog(2, `recover snapshot: ${sha.slice(0, 8)}`);
          pumpRecovery();
          const pendingRecovery = recoveryInFlight.get(sha);
          let recovered: SnapshotInput;
          if (pendingRecovery) {
            recoveryInFlight.delete(sha);
            pumpRecovery();
            recovered = await pendingRecovery;
          } else {
            recovered = parseSnapshotInline(sha);
          }
          for (const [, unit] of recovered.units) {
            persistExtractedUnitStub(unit);
          }
          let stillNeedsSnap = false;
          for (const id of missingInSnap) {
            if (!translatedUnitIds.has(id) && !failedUnitIds.has(id)) {
              stillNeedsSnap = true;
              break;
            }
          }
          if (!stillNeedsSnap) continue;
        }

        const snapPath = snapshotManifestPath(options.dataDir, sha);
        if (!existsSync(snapPath)) continue;
        const snap = readHydratedSnapshot(options.dataDir, sha, chapterCache);

        interface PendingPage {
          chap: ChapterNode;
          orderedRefs: BlockRef[];
          docOrder: number;
        }

        const countUntranslatedPageStats = (
          orderedRefs: BlockRef[],
        ): { untranslatedChars: number; pendingCount: number } => {
          let untranslatedChars = 0;
          let pendingCount = 0;
          for (const ref of orderedRefs) {
            if (translatedUnitIds.has(ref.unit_id) || failedUnitIds.has(ref.unit_id)) continue;
            const extracted = extractedUnitsById.get(ref.unit_id);
            if (!extracted || !extracted.translatable) continue;
            untranslatedChars += extracted.en.length;
            pendingCount++;
          }
          return { untranslatedChars, pendingCount };
        };

        let remainingPages: PendingPage[] = [];
        let docOrder = 0;

        for (const vol of snap.volumes) {
          const volPages: PendingPage[] = [];
          for (const chap of vol.chapters) {
            // Collect all BlockRefs in chapter order (including title_unit_id and section headings)
            const orderedRefs: BlockRef[] = [];
            const seenInChap = new Set<string>();
            const pushRef = (ref: BlockRef) => {
              if (!seenInChap.has(ref.unit_id)) {
                seenInChap.add(ref.unit_id);
                orderedRefs.push(ref);
              }
            };
            const firstHeadingPrevId =
              chap.title_unit_id && chap.sections[0]?.heading_unit_id === chap.title_unit_id
                ? chap.sections[0].heading_prev_unit_id
                : undefined;
            if (chap.title_unit_id) {
              pushRef({
                unit_id: chap.title_unit_id,
                ...(firstHeadingPrevId ? { prev_unit_id: firstHeadingPrevId } : {}),
              });
            }
            for (const sec of chap.sections) {
              if (sec.heading_unit_id) {
                pushRef({
                  unit_id: sec.heading_unit_id,
                  ...(sec.heading_anchor_id ? { anchor_id: sec.heading_anchor_id } : {}),
                  ...(sec.heading_extra_anchors ? { extra_anchors: sec.heading_extra_anchors } : {}),
                  ...(sec.heading_diff_status ? { diff_status: sec.heading_diff_status } : {}),
                  ...(sec.heading_moved_from ? { moved_from: sec.heading_moved_from } : {}),
                  ...(sec.heading_prev_unit_id ? { prev_unit_id: sec.heading_prev_unit_id } : {}),
                });
              }
              for (const ref of sec.blocks) {
                pushRef(ref);
              }
            }

            if (orderedRefs.every((r) => translatedUnitIds.has(r.unit_id))) {
              docOrder++;
              continue;
            }

            // Persist any non-translatable stubs upfront so only translatable blocks count toward page size
            for (const ref of orderedRefs) {
              if (translatedUnitIds.has(ref.unit_id)) continue;
              const extracted = extractedUnitsById.get(ref.unit_id);
              if (!extracted || extracted.translatable) continue;
              if (isVerbose(3)) {
                vlog(3, `unit ${extracted.unit_id} (${extracted.kind}, non-translatable)`);
              }
              saveTranslatedUnit({
                unit_id: extracted.unit_id,
                kind: extracted.kind as UntranslatableBlockKind,
                translatable: false,
                en: extracted.en,
              });
            }

            const { pendingCount } = countUntranslatedPageStats(orderedRefs);
            if (pendingCount > 0) {
              volPages.push({ chap, orderedRefs, docOrder });
            }
            docOrder++;
          }

          if (vol.title_unit_id && !translatedUnitIds.has(vol.title_unit_id)) {
            const volTitleRef: BlockRef = {
              unit_id: vol.title_unit_id,
              ...(vol.title_prev_unit_id ? { prev_unit_id: vol.title_prev_unit_id } : {}),
            };
            if (volPages.length > 0) {
              // Piggyback the single-line volume title onto the largest pending chapter in this volume
              // so shortest-chapter-first scheduling order is preserved.
              let largest = volPages[0];
              let largestChars = countUntranslatedPageStats(largest.orderedRefs).untranslatedChars;
              for (let i = 1; i < volPages.length; i++) {
                const chars = countUntranslatedPageStats(volPages[i].orderedRefs).untranslatedChars;
                if (chars >= largestChars) {
                  largest = volPages[i];
                  largestChars = chars;
                }
              }
              if (!largest.orderedRefs.some((r) => r.unit_id === vol.title_unit_id)) {
                largest.orderedRefs.push(volTitleRef);
              }
            } else {
              const syntheticChap: ChapterNode = vol.chapters[0] ?? {
                id: "__volume_title__",
                sectname: "chapter",
                sectnum: null,
                title_en: vol.title_en,
                source_path: vol.entry_file,
                sections: [],
              };
              const refs: BlockRef[] = [volTitleRef];
              if (countUntranslatedPageStats(refs).pendingCount > 0) {
                volPages.push({ chap: syntheticChap, orderedRefs: refs, docOrder: docOrder++ });
              }
            }
          }

          remainingPages.push(...volPages);
        }

        knownTotalPages += remainingPages.length;
        let completedPagesInSnap = 0;
        translateBar.setPages(completedPagesAcrossSnapshots, knownTotalPages);

        const hasInFlightOverlap = (orderedRefs: BlockRef[], inFlightUnitIds: Set<string>): boolean => {
          for (const ref of orderedRefs) {
            if (translatedUnitIds.has(ref.unit_id) || failedUnitIds.has(ref.unit_id)) continue;
            const extracted = extractedUnitsById.get(ref.unit_id);
            if (!extracted || !extracted.translatable) continue;
            if (inFlightUnitIds.has(ref.unit_id)) return true;
          }
          return false;
        };

        const inFlightUnitIds = new Set<string>();
        const inFlightTasks = new Map<number, Promise<void>>();
        const slotOccupied = new Array<boolean>(llmConcurrency).fill(false);
        const acquireWorkerSlot = (): number => {
          const idx = slotOccupied.indexOf(false);
          const chosen = idx >= 0 ? idx : 0;
          slotOccupied[chosen] = true;
          return chosen;
        };
        let nextTaskId = 0;
        let activePassesInFlight = 0;
        const abortController = new AbortController();
        let fatalError: unknown = null;

        const launchPageTask = (page: PendingPage, untranslatedChars: number): boolean => {
          const { chap, orderedRefs } = page;
          const chapterBlocks: ChapterContextBlock[] = [];
          const pendingRefs: Array<{ ref: BlockRef; extracted: ExtractedUnit }> = [];

          for (const ref of orderedRefs) {
            const existingToml = loadUnit(ref.unit_id);
            if (existingToml && isUnitTranslated(existingToml)) {
              chapterBlocks.push(
                existingToml.translatable
                  ? {
                      unit_id: existingToml.unit_id,
                      kind: existingToml.kind,
                      en: existingToml.en,
                      zh: existingToml.zh,
                      status: existingToml.status,
                    }
                  : {
                      unit_id: existingToml.unit_id,
                      kind: existingToml.kind,
                      en: existingToml.en,
                    },
              );
              continue;
            }

            const extracted = extractedUnitsById.get(ref.unit_id);
            if (!extracted) continue;

            if (!extracted.translatable) {
              if (isVerbose(3)) {
                vlog(3, `unit ${extracted.unit_id} (${extracted.kind}, non-translatable)`);
              }
              saveTranslatedUnit({
                unit_id: extracted.unit_id,
                kind: extracted.kind as UntranslatableBlockKind,
                translatable: false,
                en: extracted.en,
              });
              chapterBlocks.push({
                unit_id: extracted.unit_id,
                kind: extracted.kind,
                en: extracted.en,
              });
              continue;
            }

            chapterBlocks.push({
              unit_id: extracted.unit_id,
              kind: extracted.kind,
              en: extracted.en,
            });
            if (!failedUnitIds.has(ref.unit_id)) {
              pendingRefs.push({ ref, extracted });
            }
          }

          if (pendingRefs.length === 0) return false;

          const targets: TranslationTarget[] = [];
          for (const { ref, extracted } of pendingRefs) {
            if (translatedUnitIds.has(extracted.unit_id)) continue;
            let prevEn: string | undefined;
            let prevZh: string | undefined;
            const effectivePrevUnitId = ref.prev_unit_id ?? prevUnitById.get(extracted.unit_id);
            if (effectivePrevUnitId) {
              const prevUnit = loadUnit(effectivePrevUnitId);
              if (prevUnit && prevUnit.translatable && prevUnit.status !== "untranslated") {
                prevEn = prevUnit.en;
                prevZh = prevUnit.zh;
              }
            }
            targets.push({
              unit_id: extracted.unit_id,
              en: extracted.en,
              kind: extracted.kind,
              prev_en: prevEn,
              prev_zh: prevZh,
            });
          }

          if (targets.length === 0) return false;

          const taskId = nextTaskId++;
          const slotIdx = acquireWorkerSlot();
          const taskStartedAt = Date.now();
          let slotReleased = false;
          const releaseWorkerSlot = () => {
            if (slotReleased) return;
            slotReleased = true;
            slotOccupied[slotIdx] = false;
            translateBar.clearWorker(slotIdx);
          };

          const pendingByUnitId = new Map(
            pendingRefs.map((entry) => [entry.extracted.unit_id, entry]),
          );
          for (const target of targets) {
            inFlightUnitIds.add(target.unit_id);
          }
          activePassesInFlight++;
          let passReserved = true;
          let completedPassesInTask = 0;
          let uncountedPassStarted = false;

          translateBar.setWorker(
            slotIdx,
            {
              documentTitle: chap.title_en,
              unitCount: targets.length,
              startedAt: taskStartedAt,
              progress: null,
            },
            true,
          );

          vlog(
            2,
            `translate batch ${completedBatches + activePassesInFlight}: chapter="${chap.title_en}" (${targets.length} targets, ${untranslatedChars} chars, ${chapterBlocks.length} context)`,
          );

          const taskPromise = (async () => {
            let passStartedAt = taskStartedAt;
            let lastPassFinishEvent: LlmProgressSnapshot | null = null;
            try {
              await translateChapterBatch({
                glossaryMarkdown,
                chapterTitle: chap.title_en,
                chapterBlocks,
                targets,
                provider: options.provider,
                model: options.model,
                baseUrl: options.baseUrl,
                reasoningEffort: options.reasoningEffort,
                abortSignal: abortController.signal,
                maxInputTokens: options.maxInputTokens,
                maxOutputTokens: options.maxOutputTokens,
                onLlmProgress: (event) => {
                  uncountedPassStarted = true;
                  if (event.phase === "finish") {
                    hasCompletedLlmCall = true;
                    lastPassFinishEvent = event;
                    totalInputTokens += event.inputTokens;
                    if (!event.exactInput && event.inputTokens > 0) {
                      allInputExact = false;
                    }
                    totalOutputTokens += event.outputTokens;
                    if (!event.exactOutput && event.outputTokens > 0) {
                      allOutputExact = false;
                    }
                    if (event.genMs !== undefined && event.genMs >= 20 && event.outputTokens > 0) {
                      totalTimedOutputTokens += event.outputTokens;
                      totalGenMs += event.genMs;
                    }
                  }
                  translateBar.setWorker(
                    slotIdx,
                    {
                      documentTitle: chap.title_en,
                      unitCount: targets.length,
                      passIndex: event.passIndex,
                      totalPasses: event.totalPasses,
                      startedAt: taskStartedAt,
                      progress: {
                        phase: event.phase,
                        inputTokens: event.inputTokens,
                        exactInput: event.exactInput,
                        outputTokens: event.outputTokens,
                        exactOutput: event.exactOutput,
                        tokPerSec: event.tokPerSec,
                      },
                    },
                    event.phase !== "stream",
                  );
                },
                onPassComplete: (passResults, { passIndex, totalPasses }) => {
                  for (const [unitId, translated] of passResults) {
                    const entry = pendingByUnitId.get(unitId);
                    if (!entry) continue;
                    if (isVerbose(3)) {
                      vlog(3, `unit ${unitId} (${entry.extracted.kind}, ${translated.status})`);
                    }
                    saveTranslatedUnit({
                      unit_id: unitId,
                      kind: entry.extracted.kind as TranslatableBlockKind,
                      translatable: true,
                      status: translated.status,
                      en: entry.extracted.en,
                      zh: translated.zh,
                    });
                    inFlightUnitIds.delete(unitId);
                    translatedUnits++;
                  }

                  if (passReserved) {
                    activePassesInFlight--;
                    passReserved = false;
                  }
                  completedBatches++;
                  completedPassesInTask++;
                  uncountedPassStarted = false;
                  if (isCiEnv()) {
                    const passLabel = totalPasses > 1 ? ` (pass ${passIndex + 1}/${totalPasses})` : "";
                    const tokenDetail = lastPassFinishEvent
                      ? `, ${formatLlmProgress(lastPassFinishEvent)}`
                      : "";
                    info(
                      `translate [${completedBatches}]: "${chap.title_en}"${passLabel} — +${passResults.size} units (${translatedUnits}/${pendingTotal})${tokenDetail}, ${formatDuration(Date.now() - passStartedAt)}`,
                      options.log,
                    );
                  }
                  lastPassFinishEvent = null;
                  passStartedAt = Date.now();
                  translateBar.update(translatedUnits, {
                    donePages: completedPagesAcrossSnapshots + completedPagesInSnap,
                    totalPages: knownTotalPages,
                  });

                  if (passIndex + 1 < totalPasses) {
                    if (fatalError !== null || abortController.signal.aborted) {
                      return false;
                    }
                    if (
                      isTimeBudgetExceeded() ||
                      (options.maxBatches !== undefined &&
                        completedBatches + activePassesInFlight >= options.maxBatches)
                    ) {
                      budgetReached = true;
                      return false;
                    }
                    activePassesInFlight++;
                    passReserved = true;
                    translateBar.setWorker(
                      slotIdx,
                      {
                        documentTitle: chap.title_en,
                        unitCount: targets.length,
                        passIndex: passIndex + 1,
                        totalPasses,
                        startedAt: taskStartedAt,
                        progress: null,
                      },
                      true,
                    );
                  }
                  return true;
                },
              });

              if (targets.every((t) => translatedUnitIds.has(t.unit_id))) {
                completedPagesInSnap++;
              }
              releaseWorkerSlot();
              translateBar.update(translatedUnits, {
                donePages: completedPagesAcrossSnapshots + completedPagesInSnap,
                totalPages: knownTotalPages,
              });
            } catch (batchErr) {
              if (passReserved) {
                activePassesInFlight--;
                passReserved = false;
              }
              releaseWorkerSlot();

              if (abortController.signal.aborted && fatalError !== null) {
                return;
              }

              const msg = batchErr instanceof Error ? batchErr.message : String(batchErr);
              const wrappedErr = msg.includes(`chapter "${chap.title_en}"`)
                ? batchErr instanceof Error
                  ? batchErr
                  : new Error(msg)
                : new Error(
                    `Translation failed for chapter "${chap.title_en}": ${msg}`,
                    batchErr instanceof Error ? { cause: batchErr } : undefined,
                  );

              if (failFast) {
                fatalError ??= wrappedErr;
                abortController.abort();
                return;
              }

              failedPages++;
              if (uncountedPassStarted || completedPassesInTask === 0) {
                completedBatches++;
              }
              for (const target of targets) {
                if (!translatedUnitIds.has(target.unit_id)) {
                  failedUnitIds.add(target.unit_id);
                }
              }
              const prefix = msg.includes(`chapter "${chap.title_en}"`)
                ? "sync: translation failed"
                : `sync: translation failed for chapter "${chap.title_en}"`;
              error(`${prefix}: ${msg}`, options.log);
              translateBar.update(translatedUnits, {
                donePages: completedPagesAcrossSnapshots + completedPagesInSnap,
                totalPages: knownTotalPages,
              });
            } finally {
              if (passReserved) {
                activePassesInFlight--;
                passReserved = false;
              }
              for (const target of targets) {
                inFlightUnitIds.delete(target.unit_id);
              }
              releaseWorkerSlot();
              inFlightTasks.delete(taskId);
            }
          })();

          inFlightTasks.set(taskId, taskPromise);
          return true;
        };

        while (remainingPages.length > 0 || inFlightTasks.size > 0) {
          if (fatalError !== null || budgetReached) {
            break;
          }

          let launchedAny = false;
          if (remainingPages.length > 0) {
            const candidates: Array<{
              page: PendingPage;
              untranslatedChars: number;
              pendingCount: number;
            }> = [];
            let pageCountedComplete = false;
            for (const page of remainingPages) {
              const stats = countUntranslatedPageStats(page.orderedRefs);
              if (stats.pendingCount > 0) {
                candidates.push({
                  page,
                  untranslatedChars: stats.untranslatedChars,
                  pendingCount: stats.pendingCount,
                });
              } else if (!page.orderedRefs.some((r) => failedUnitIds.has(r.unit_id))) {
                completedPagesInSnap++;
                pageCountedComplete = true;
              }
            }
            if (pageCountedComplete) {
              translateBar.setPages(
                completedPagesAcrossSnapshots + completedPagesInSnap,
                knownTotalPages,
              );
            }

            // Translate shorter pages first across all volumes in this snapshot
            candidates.sort(
              (a, b) =>
                a.untranslatedChars - b.untranslatedChars ||
                a.pendingCount - b.pendingCount ||
                a.page.orderedRefs.length - b.page.orderedRefs.length ||
                a.page.docOrder - b.page.docOrder,
            );

            const nextRemaining: PendingPage[] = [];
            let blockedByBudget = false;
            for (let i = 0; i < candidates.length; i++) {
              const cand = candidates[i];
              if (
                isTimeBudgetExceeded() ||
                (options.maxBatches !== undefined &&
                  completedBatches + activePassesInFlight >= options.maxBatches)
              ) {
                blockedByBudget = true;
                for (let j = i; j < candidates.length; j++) {
                  nextRemaining.push(candidates[j].page);
                }
                break;
              }
              if (inFlightTasks.size >= llmConcurrency) {
                for (let j = i; j < candidates.length; j++) {
                  nextRemaining.push(candidates[j].page);
                }
                break;
              }
              if (hasInFlightOverlap(cand.page.orderedRefs, inFlightUnitIds)) {
                nextRemaining.push(cand.page);
                continue;
              }

              if (launchPageTask(cand.page, cand.untranslatedChars)) {
                launchedAny = true;
              }
            }
            remainingPages = nextRemaining;

            if (blockedByBudget && inFlightTasks.size === 0) {
              budgetReached = true;
              break;
            }
          }

          if (fatalError !== null || budgetReached) {
            break;
          }

          if (inFlightTasks.size > 0) {
            await Promise.race(inFlightTasks.values());
          } else if (!launchedAny) {
            break;
          }
        }

        if (inFlightTasks.size > 0) {
          await Promise.all(inFlightTasks.values());
        }
        if (fatalError !== null) {
          throw fatalError;
        }
        completedPagesAcrossSnapshots += completedPagesInSnap;
        translateBar.update(translatedUnits, {
          donePages: completedPagesAcrossSnapshots,
          totalPages: knownTotalPages,
        });
        if (budgetReached) {
          break snapshotLoop;
        }
      }
      const detailParts: string[] = [];
      if (hasCompletedLlmCall) {
        detailParts.push(formatCumulativeSummary());
      }
      if (failedPages > 0) {
        detailParts.push(`${failedPages} failed`);
      }
      if (budgetReached) {
        detailParts.push("budget reached");
      }
      if (detailParts.length > 0) {
        translateBar.done({ detail: detailParts.join(", ") });
      } else {
        translateBar.done();
      }
    } finally {
      translateBar.clear();
    }

    return {
      processedCommits,
      translatedUnits,
      hasRemaining: allMissingIds.size > 0,
      ...(failedPages > 0 ? { failedPages } : {}),
    };
  } catch (err) {
    syncFailed = true;
    throw err;
  } finally {
    try {
      if (commitChanges) {
        if (syncFailed || allMissingIds.size > 0) {
          gitCommitIfDirty(options.dataDir, "chore(sync): checkpoint translations [skip ci]");
        } else {
          const shortSha = (manifestIndex.last_synced_sha ?? remote.headSha).slice(0, 8);
          vlog(1, `sync: committing ${shortSha} (${translatedUnits} translated units)`);
          gitCommitIfDirty(
            options.dataDir,
            `chore(sync): sync upstream ${shortSha} (${translatedUnits} units)`,
          );
        }
      }
    } catch (commitErr) {
      if (!syncFailed) throw commitErr;
    } finally {
      if (snapshotPool) {
        await snapshotPool.close();
      }
      if (tmpWorktreesDir) {
        rmSync(tmpWorktreesDir, { recursive: true, force: true });
      }
      if (tmpRepo) {
        rmSync(tmpRepo, { recursive: true, force: true });
      }
    }
  }
}
