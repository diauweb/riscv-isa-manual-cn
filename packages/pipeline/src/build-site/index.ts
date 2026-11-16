import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AnchorIndexSchema,
  ChapterStructureSchema,
  ChapterUnitPackSchema,
  ManifestIndexSchema,
  SiteIndexSchema,
  SiteTreeSchema,
  compactBlockEntry,
  type AnchorTarget,
  type BlockKind,
  type ChapterManifest,
  type ChapterStructure,
  type ChapterUnitPack,
  type DiffStatus,
  type RenderedUnit,
  type SearchEntry,
  type SiteChapterEntry,
  type SiteIndex,
  type SiteSectionNode,
  type SiteSnapshot,
  type SiteTree,
  type SiteVolume,
  type TranslationStatus,
  type UnitHtmlOverride,
  type UnitMeta,
  type UnitRevisionEntry,
  type UnitToml,
  type UnitUpstreamRef,
  type UpstreamChangeKind,
  type VolumeId,
} from "@riscv-cn/schema";
import { encode as encodeHtmlEntities } from "he";
import { isVerbose, vlog } from "../log.ts";
import {
  readHydratedSnapshot,
  snapshotManifestPath,
  type HydratedSnapshot,
} from "../manifests/index.ts";
import { formatBibEntry } from "../parser/bibtex.ts";
import {
  cleanPlainHeadingTitle,
  extractCodeSymbols,
  htmlToPlainText,
  renderAdocFragment,
  rewriteHtmlXrefs,
  type XrefTargetInfo,
} from "../parser/index.ts";
import {
  createWorkerPool,
  defaultJobs,
  loadUnitsParallel,
  MIN_PARALLEL_ITEMS,
  renderFragmentsParallel,
  type WorkerPool,
} from "../parallel/index.ts";
import { createProgress } from "../progress.ts";
import {
  createSiteResourceResolver,
  extractBibEntriesFromUpstream,
  type ResourceResolveContext,
} from "../resources.ts";
import { parseUnitToml } from "../toml/index.ts";

export interface BuildSiteOptions {
  dataDir: string;
  outDir: string;
  dataRepoUrl?: string;
  upstreamRepoUrl?: string;
  upstreamDir?: string;
  renderCache?: Map<string, string>;
  jobs?: number;
}

export interface BuildSiteResult {
  snapshots: number;
  trees: number;
  chapters: number;
  packs: number;
  units: number;
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

function shortShaHash(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16);
}

function getTranslatedZh(unit: UnitToml | undefined): string {
  if (!unit || !unit.translatable || unit.status === "untranslated") {
    return "";
  }
  return unit.zh.trim().length > 0 ? unit.zh : "";
}

function resolveVolumeTitles(
  vol: HydratedSnapshot["volumes"][number],
  unitMap: Map<string, UnitToml>,
): { titleEn: string; titleZh: string } {
  const titleUnit = vol.title_unit_id ? unitMap.get(vol.title_unit_id) : undefined;
  const titleEn = titleUnit
    ? cleanPlainHeadingTitle(titleUnit.en) || cleanPlainHeadingTitle(vol.title_en) || vol.title_en
    : cleanPlainHeadingTitle(vol.title_en) || vol.title_en;
  const zhRaw = getTranslatedZh(titleUnit);
  const titleZh = zhRaw ? cleanPlainHeadingTitle(zhRaw) || titleEn : titleEn;
  return { titleEn, titleZh };
}

function extractExtraAnchors(adoc: string, primaryAnchor?: string): string[] {
  const found = new Set<string>();
  const reDouble = /\[\[([A-Za-z_][A-Za-z0-9_.:-]*)(?:,[^\]]*)?\]\]/g;
  const reHash = /\[#([A-Za-z_][A-Za-z0-9_.:-]*)(?:\.[^\]\s]+)*\]/g;
  const reMacro = /\banchor:([A-Za-z_][A-Za-z0-9_.:-]*)\[/g;
  for (const re of [reDouble, reHash, reMacro]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(adoc)) !== null) {
      const id = m[1];
      if (id && id !== primaryAnchor && !id.startsWith("_footnote")) {
        found.add(id);
      }
    }
  }
  return [...found];
}

function extractHtmlBlockTitle(html: string): string | undefined {
  const m = /<(?:caption|div) class="title">([^<]+)<\/(?:caption|div)>/i.exec(html);
  const title = m?.[1]?.trim();
  return title || undefined;
}

interface PendingRevisionEntry {
  fileUnitId: string;
  commitSha: string;
  date: string;
  author: string;
  message: string;
  resolved?: { pureUnitId: string; status: TranslationStatus; zh: string };
  spec?: string;
}

interface ResolvedBlobRevision {
  pureUnitId: string;
  status: TranslationStatus;
  zh: string;
}

function extractGitRevisions(
  dataDir: string,
  unitMap: Map<string, UnitToml>,
): Map<string, UnitRevisionEntry[]> {
  const revisions = new Map<string, UnitRevisionEntry[]>();

  const isRepo = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd: dataDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (isRepo.exitCode !== 0 || isRepo.stdout.toString("utf8").trim() !== "true") {
    return revisions;
  }

  const hasHead = Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD"], {
    cwd: dataDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (hasHead.exitCode !== 0) {
    return revisions;
  }

  const dirtyUnitIds = new Set<string>();
  const statusProc = Bun.spawnSync(["git", "status", "--porcelain", "-uall", "--", "units/"], {
    cwd: dataDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const statusOk = statusProc.exitCode === 0;
  if (statusOk) {
    for (const line of statusProc.stdout.toString("utf8").split("\n")) {
      for (const m of line.matchAll(/units\/[0-9a-f]{2}\/([0-9a-f]{32})\.toml/g)) {
        dirtyUnitIds.add(m[1]);
      }
    }
  }

  const logProc = Bun.spawnSync(
    ["git", "log", "--format=COMMIT%x00%H%x00%aI%x00%an%x00%s", "--name-only", "--", "units/"],
    {
      cwd: dataDir,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (logProc.exitCode !== 0) {
    return revisions;
  }

  const seenLatestForUnit = new Set<string>();
  const rawEntries: PendingRevisionEntry[] = [];
  const specSet = new Set<string>();
  const specsToFetch: string[] = [];

  const lines = logProc.stdout.toString("utf8").split("\n");
  let currentCommit: { sha: string; date: string; author: string; message: string } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("COMMIT\0")) {
      const parts = line.split("\0");
      currentCommit = {
        sha: parts[1] ?? "",
        date: parts[2] ?? "",
        author: parts[3] ?? "",
        message: parts.slice(4).join("\0"),
      };
      continue;
    }

    if (!currentCommit) continue;
    const match = line.match(/^units\/[0-9a-f]{2}\/([0-9a-f]{32})\.toml$/);
    if (!match) continue;
    const fileUnitId = match[1];

    const isLatestCommitForUnit = !seenLatestForUnit.has(fileUnitId);
    if (isLatestCommitForUnit) {
      seenLatestForUnit.add(fileUnitId);
    }

    const diskUnit =
      isLatestCommitForUnit && statusOk && !dirtyUnitIds.has(fileUnitId)
        ? unitMap.get(fileUnitId)
        : undefined;

    if (diskUnit) {
      if (
        diskUnit.translatable &&
        diskUnit.status !== "untranslated" &&
        diskUnit.zh.trim().length > 0
      ) {
        rawEntries.push({
          fileUnitId,
          commitSha: currentCommit.sha,
          date: currentCommit.date,
          author: currentCommit.author,
          message: currentCommit.message,
          resolved: {
            pureUnitId: diskUnit.unit_id,
            status: diskUnit.status,
            zh: diskUnit.zh,
          },
        });
      }
    } else {
      const spec = `${currentCommit.sha}:${line}`;
      rawEntries.push({
        fileUnitId,
        commitSha: currentCommit.sha,
        date: currentCommit.date,
        author: currentCommit.author,
        message: currentCommit.message,
        spec,
      });
      if (!specSet.has(spec)) {
        specSet.add(spec);
        specsToFetch.push(spec);
      }
    }
  }

  const specToParsed = new Map<string, ResolvedBlobRevision | null>();
  if (specsToFetch.length > 0) {
    const parsedByBlobOid = new Map<string, ResolvedBlobRevision | null>();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const CHUNK_SIZE = 1000;

    for (let start = 0; start < specsToFetch.length; start += CHUNK_SIZE) {
      const chunk = specsToFetch.slice(start, start + CHUNK_SIZE);
      const batchProc = Bun.spawnSync(["git", "cat-file", "--batch"], {
        cwd: dataDir,
        stdin: encoder.encode(`${chunk.join("\n")}\n`),
        stdout: "pipe",
        stderr: "pipe",
      });
      if (batchProc.exitCode !== 0) {
        throw new Error(`git cat-file --batch failed: ${batchProc.stderr.toString("utf8")}`);
      }

      const buf = batchProc.stdout;
      let pos = 0;
      for (const spec of chunk) {
        const nlIdx = buf.indexOf(0x0a, pos);
        if (nlIdx < 0) break;
        const header = decoder.decode(buf.subarray(pos, nlIdx));
        pos = nlIdx + 1;

        if (!header.includes(" blob ")) {
          const parts = header.split(" ");
          if (parts.length === 3 && /^\d+$/.test(parts[2])) {
            pos += Number(parts[2]) + 1;
          }
          specToParsed.set(spec, null);
          continue;
        }

        const space1 = header.indexOf(" ");
        const space2 = header.indexOf(" ", space1 + 1);
        const oid = header.slice(0, space1);
        const size = Number(header.slice(space2 + 1));
        const contentBytes = buf.subarray(pos, pos + size);
        pos += size + 1;

        let parsed = parsedByBlobOid.get(oid);
        if (parsed === undefined) {
          const unit = parseUnitToml(decoder.decode(contentBytes));
          if (!unit.translatable || unit.status === "untranslated" || unit.zh.trim().length === 0) {
            parsed = null;
          } else {
            parsed = {
              pureUnitId: unit.unit_id,
              status: unit.status,
              zh: unit.zh,
            };
          }
          parsedByBlobOid.set(oid, parsed);
        }
        specToParsed.set(spec, parsed);
      }
    }
  }

  // Group newest-first entries by pureUnitId, then deduplicate consecutive identical (status, zh)
  // states oldest-to-newest so original translator attribution is preserved across mechanical rewrites.
  const grouped = new Map<string, Array<{ entry: PendingRevisionEntry; resolved: ResolvedBlobRevision }>>();
  for (const entry of rawEntries) {
    const resolved = entry.resolved ?? (entry.spec ? specToParsed.get(entry.spec) : null);
    if (!resolved) continue;
    let bucket = grouped.get(resolved.pureUnitId);
    if (!bucket) {
      bucket = [];
      grouped.set(resolved.pureUnitId, bucket);
    }
    bucket.push({ entry, resolved });
  }

  for (const [pureUnitId, descList] of grouped) {
    const dedupAsc: UnitRevisionEntry[] = [];
    for (let i = descList.length - 1; i >= 0; i--) {
      const { entry, resolved } = descList[i];
      const prev = dedupAsc[dedupAsc.length - 1];
      if (prev && prev.status === resolved.status && prev.zh === resolved.zh) {
        continue;
      }
      dedupAsc.push({
        commit_sha: entry.commitSha,
        date: entry.date,
        author: entry.author,
        message: entry.message,
        status: resolved.status,
        zh: resolved.zh,
      });
    }
    revisions.set(pureUnitId, dedupAsc.reverse());
  }

  return revisions;
}

/**
 * Compiles the data repository into decoupled static viewer artifacts:
 * `index.json`, `trees/<hash>.json`, `chapters/<hash>.json`, `packs/<hash>.json`,
 * `anchors.json`, `meta/<2-hex>.json`, `search.json`, and `assets/<hash>.<ext>`.
 */
export async function buildSiteData(options: BuildSiteOptions): Promise<BuildSiteResult> {
  const jobs = Math.max(1, Math.floor(options.jobs ?? defaultJobs()));
  const indexPath = join(options.dataDir, "manifests", "index.json");
  const glossaryPath = join(options.dataDir, "GLOSSARY.md");

  const manifestIndex = ManifestIndexSchema.parse(JSON.parse(readFileSync(indexPath, "utf8")));
  const glossaryMarkdown = existsSync(glossaryPath) ? readFileSync(glossaryPath, "utf8") : "";

  const existingSnapshotPaths: Array<{ sha: string; path: string }> = [];
  for (const commitEntry of manifestIndex.commits) {
    const snapPath = snapshotManifestPath(options.dataDir, commitEntry.sha);
    if (existsSync(snapPath)) {
      existingSnapshotPaths.push({ sha: commitEntry.sha, path: snapPath });
    }
  }

  const unitMap = new Map<string, UnitToml>();
  const unitFiles = walkTomlFiles(join(options.dataDir, "units"));
  const renderCache = options.renderCache ?? new Map<string, string>();
  let pool: WorkerPool | null = null;

  try {
    if (jobs > 1 && unitFiles.length >= MIN_PARALLEL_ITEMS) {
      const unitChunkSize = Math.max(32, Math.ceil(unitFiles.length / (jobs * 4)));
      const unitChunksCount = Math.ceil(unitFiles.length / unitChunkSize);
      pool = createWorkerPool(Math.min(jobs, unitChunksCount));
    }

    vlog(1, `build-site: loading ${unitFiles.length} unit(s) from ${options.dataDir}`);
    const loadBar = createProgress({ label: "Loading units", total: unitFiles.length });
    try {
      if (pool && jobs > 1 && unitFiles.length >= MIN_PARALLEL_ITEMS) {
        const loadedUnits = await loadUnitsParallel(
          unitFiles,
          jobs,
          (loaded) => loadBar.update(loaded),
          pool,
        );
        for (const unit of loadedUnits) {
          unitMap.set(unit.unit_id, unit);
          if (isVerbose(3)) {
            vlog(3, `load unit ${unit.unit_id} (${unit.kind}, ${unit.translatable ? unit.status : "untranslatable"})`);
          }
        }
      } else {
        for (const file of unitFiles) {
          const unit = parseUnitToml(readFileSync(file, "utf8"));
          unitMap.set(unit.unit_id, unit);
          if (isVerbose(3)) {
            vlog(3, `load unit ${unit.unit_id} (${unit.kind}, ${unit.translatable ? unit.status : "untranslatable"})`);
          }
          loadBar.increment();
        }
      }
      loadBar.done();
    } finally {
      loadBar.clear();
    }

    if (existingSnapshotPaths.length > 0 && jobs > 1) {
      const uncachedItems: Array<{ key: string; text: string; kind: BlockKind }> = [];
      const queuedKeys = new Set<string>();
      const enqueueIfMissing = (text: string, kind: BlockKind) => {
        if (!text.trim()) return;
        const key = `${kind}\0${text}`;
        if (renderCache.has(key) || queuedKeys.has(key)) return;
        queuedKeys.add(key);
        uncachedItems.push({ key, text, kind });
      };
      for (const unit of unitMap.values()) {
        enqueueIfMissing(unit.en, unit.kind);
        const zhRaw = getTranslatedZh(unit);
        if (zhRaw && zhRaw !== unit.en) {
          enqueueIfMissing(zhRaw, unit.kind);
        }
      }

      if (uncachedItems.length >= MIN_PARALLEL_ITEMS) {
        pool ??= createWorkerPool(Math.min(jobs, Math.ceil(uncachedItems.length / 32)));
        vlog(1, `build-site: pre-rendering ${uncachedItems.length} uncached fragment(s) across ${pool.size} workers`);
        const renderBar = createProgress({ label: "Rendering units", total: uncachedItems.length });
        try {
          const pairs = await renderFragmentsParallel(
            uncachedItems,
            jobs,
            (done) => renderBar.update(done),
            pool,
          );
          for (const [key, html] of pairs) {
            renderCache.set(key, html);
          }
          renderBar.done();
        } finally {
          renderBar.clear();
        }
      }
    }
  } finally {
    if (pool) {
      await pool.close();
      pool = null;
    }
  }

  vlog(1, `build-site: extracting git revisions`);
  const revisionsByUnit = extractGitRevisions(options.dataDir, unitMap);

  const treesDir = join(options.outDir, "trees");
  const chaptersDir = join(options.outDir, "chapters");
  const packsDir = join(options.outDir, "packs");
  const metaDir = join(options.outDir, "meta");
  mkdirSync(treesDir, { recursive: true });
  mkdirSync(chaptersDir, { recursive: true });
  mkdirSync(packsDir, { recursive: true });
  mkdirSync(metaDir, { recursive: true });

  const normalizeRepoUrl = (raw: string): string =>
    raw.trim().replace(/\/+$/, "").replace(/\.git$/, "");

  const inferredUpstreamUrl = /^https?:\/\//.test(manifestIndex.upstream_repo)
    ? manifestIndex.upstream_repo
    : "https://github.com/riscv/riscv-isa-manual";

  const dataRepoUrl = options.dataRepoUrl?.trim()
    ? normalizeRepoUrl(options.dataRepoUrl)
    : "";
  const upstreamRepoUrl = options.upstreamRepoUrl?.trim()
    ? normalizeRepoUrl(options.upstreamRepoUrl)
    : normalizeRepoUrl(inferredUpstreamUrl);

  const ratifiedBySha = new Map<string, boolean>(
    manifestIndex.commits.map((c) => [c.sha, c.ratified_tag !== null]),
  );
  const resourceResolver = createSiteResourceResolver({
    dataDir: options.dataDir,
    outDir: options.outDir,
    upstreamDir: options.upstreamDir,
    upstreamRepoUrl,
    snapshots: existingSnapshotPaths.map((s) => ({
      sha: s.sha,
      ratified: Boolean(ratifiedBySha.get(s.sha)),
    })),
    latestSha:
      manifestIndex.last_synced_sha ??
      existingSnapshotPaths[existingSnapshotPaths.length - 1]?.sha ??
      null,
  });

  const getRenderedHtml = (text: string, kind: BlockKind): string => {
    const key = `${kind}\0${text}`;
    let html = renderCache.get(key);
    if (html === undefined) {
      html = renderAdocFragment(text, kind);
      renderCache.set(key, html);
    }
    return html;
  };

  // Pick default_sha upfront: latest ratified snapshot, else latest existing snapshot.
  let defaultSnapMeta: { sha: string; path: string } | null = null;
  let lastSnapMeta: { sha: string; path: string } | null = null;
  for (const s of existingSnapshotPaths) {
    lastSnapMeta = s;
    if (ratifiedBySha.get(s.sha)) {
      defaultSnapMeta = s;
    }
  }
  defaultSnapMeta ??= lastSnapMeta;
  const chapterManifestCache = new Map<string, ChapterManifest>();
  const defaultSha = defaultSnapMeta?.sha ?? manifestIndex.last_synced_sha ?? "";
  const defaultSnap: HydratedSnapshot | null = defaultSnapMeta
    ? readHydratedSnapshot(options.dataDir, defaultSnapMeta.sha, chapterManifestCache)
    : null;

  const bibEntries = extractBibEntriesFromUpstream(
    options.upstreamDir,
    defaultSha || manifestIndex.last_synced_sha || null,
  );

  const enrichCitations = (html: string): string => {
    if (bibEntries.size === 0 || !html.includes("cite-ref")) return html;
    return html.replace(
      /<a class="cite-ref" href="#bib-([^"]+)" data-cite-key="([^"]+)"(?: data-cite-mode="([^"]*)")?>([^<]*)<\/a>/g,
      (full, _hrefKey: string, key: string, mode: string | undefined, inner: string) => {
        const entry = bibEntries.get(key);
        if (!entry) return full;
        const formatted = encodeHtmlEntities(formatBibEntry(entry));
        let label = inner;
        if (mode === "year" && entry.year) label = encodeHtmlEntities(entry.year);
        else if ((mode === "author" || mode === "t") && entry.author) {
          const shortAuthor = entry.author.split(/\s+and\s+/i)[0].split(",")[0].trim();
          label = mode === "t" && entry.year
            ? encodeHtmlEntities(`${shortAuthor} (${entry.year})`)
            : encodeHtmlEntities(shortAuthor);
        }
        const modeAttr = mode ? ` data-cite-mode="${mode}"` : "";
        return `<a class="cite-ref" href="#bib-${key}" data-cite-key="${key}"${modeAttr} title="${formatted}" data-cite-text="${formatted}">${label}</a>`;
      },
    );
  };

  // Identify dynamic units (containing images or links/xrefs) so static units are rendered once.
  const dynamicUnits = new Set<string>();
  for (const unit of unitMap.values()) {
    const enHtml = getRenderedHtml(unit.en, unit.kind);
    const zhRaw = getTranslatedZh(unit);
    const zhHtml = zhRaw ? (zhRaw === unit.en ? enHtml : getRenderedHtml(zhRaw, unit.kind)) : "";
    if (
      unit.kind === "diagram" ||
      unit.en.includes("image:") ||
      zhRaw.includes("image:") ||
      enHtml.includes("<img") ||
      zhHtml.includes("<img") ||
      enHtml.includes("<a") ||
      zhHtml.includes("<a")
    ) {
      dynamicUnits.add(unit.unit_id);
    }
  }

  const buildSnapshotSymbols = (snap: HydratedSnapshot): Map<string, XrefTargetInfo> => {
    const symbols = new Map<string, XrefTargetInfo>();
    const register = (key: string | undefined, info: XrefTargetInfo) => {
      if (!key || symbols.has(key)) return;
      symbols.set(key, info);
    };

    for (const vol of snap.volumes) {
      for (const chap of vol.chapters) {
        const chapTitleUnit = chap.title_unit_id ? unitMap.get(chap.title_unit_id) : undefined;
        const chapTitleEn =
          (chapTitleUnit ? cleanPlainHeadingTitle(chapTitleUnit.en) : "") ||
          cleanPlainHeadingTitle(chap.title_en) ||
          chap.title_en;
        const chapTitleZhRaw = getTranslatedZh(chapTitleUnit);
        const chapTitleZh = chapTitleZhRaw
          ? cleanPlainHeadingTitle(chapTitleZhRaw) || chapTitleEn
          : chapTitleEn;

        const isBibChapter = chap.id.toLowerCase().includes("bib");
        register(chap.id, {
          anchor_id: chap.id,
          volume_id: vol.id,
          chapter_id: chap.id,
          section_id: chap.sections[0]?.id,
          sectnum: chap.sectnum ?? null,
          sectname: chap.sectname,
          kind: "heading",
          title_en: chapTitleEn,
          title_zh: chapTitleZh,
        });

        for (const sec of chap.sections) {
          const hUnit = sec.heading_unit_id ? unitMap.get(sec.heading_unit_id) : undefined;
          const secTitleEn =
            (hUnit ? cleanPlainHeadingTitle(hUnit.en) : "") ||
            cleanPlainHeadingTitle(sec.title) ||
            sec.title;
          const secTitleZhRaw = getTranslatedZh(hUnit);
          const secTitleZh = secTitleZhRaw
            ? cleanPlainHeadingTitle(secTitleZhRaw) || secTitleEn
            : secTitleEn;
          const isBibSection = isBibChapter || sec.id.toLowerCase().includes("bib");

          const secInfo: XrefTargetInfo = {
            anchor_id: sec.id,
            volume_id: vol.id,
            chapter_id: chap.id,
            section_id: sec.id,
            sectnum: sec.sectnum ?? null,
            ...(sec.level <= 1 ? { sectname: chap.sectname } : {}),
            kind: sec.level <= 1 ? "heading" : "section",
            title_en: secTitleEn,
            title_zh: secTitleZh,
          };
          register(sec.id, secInfo);
          register(sec.heading_anchor_id, secInfo);
          if (sec.heading_extra_anchors) {
            for (const extra of sec.heading_extra_anchors) {
              register(extra, secInfo);
            }
          }
          if (hUnit) {
            for (const extra of extractExtraAnchors(hUnit.en, sec.heading_anchor_id)) {
              register(extra, secInfo);
            }
          }

          for (const b of sec.blocks) {
            const u = unitMap.get(b.unit_id);
            const inlineExtras = u ? extractExtraAnchors(u.en, b.anchor_id) : [];
            const allBlockAnchors = [
              ...(b.anchor_id ? [b.anchor_id] : []),
              ...(b.extra_anchors ?? []),
              ...inlineExtras,
            ];
            if (allBlockAnchors.length === 0) continue;

            const kind = u?.kind ?? "paragraph";
            const isBib = isBibSection || Boolean(u?.en.trim().startsWith("* [[["));
            let titleEn: string | undefined;
            let titleZh: string | undefined;
            if (u && (kind === "table" || kind === "diagram" || kind === "block")) {
              titleEn = extractHtmlBlockTitle(getRenderedHtml(u.en, kind));
              const zhRaw = getTranslatedZh(u);
              if (zhRaw) {
                titleZh = extractHtmlBlockTitle(getRenderedHtml(zhRaw, kind));
              }
            }
            const primaryAnchor = b.anchor_id ?? allBlockAnchors[0];
            for (const a of allBlockAnchors) {
              register(a, {
                anchor_id: b.anchor_id ? primaryAnchor : a,
                volume_id: vol.id,
                chapter_id: chap.id,
                section_id: sec.id,
                sectnum: sec.sectnum ?? null,
                kind,
                ...(titleEn ? { title_en: titleEn } : {}),
                ...(titleZh ? { title_zh: titleZh } : {}),
                ...(isBib ? { is_bibliography: true } : {}),
              });
            }
          }
        }
      }
    }

    return symbols;
  };

  const renderForSnapshot = (
    text: string,
    kind: BlockKind,
    ctx: ResourceResolveContext,
    lang: "en" | "zh",
    symbols: ReadonlyMap<string, XrefTargetInfo>,
  ): string => {
    const baseHtml = getRenderedHtml(text, kind);
    const resHtml = resourceResolver.rewriteHtml(baseHtml, ctx);
    const xrefHtml = rewriteHtmlXrefs(resHtml, lang, symbols);
    return enrichCitations(xrefHtml);
  };

  const buildChapterRenderableIds = (chap: HydratedSnapshot["volumes"][number]["chapters"][number]): string[] => {
    const seen = new Set<string>();
    const ids: string[] = [];
    const add = (id?: string) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    };
    add(chap.title_unit_id);
    for (const sec of chap.sections) {
      add(sec.heading_unit_id);
      for (const b of sec.blocks) {
        add(b.unit_id);
      }
    }
    return ids;
  };

  // Pass 1: Pool all unit IDs per `(volume_id, chapter_id)` across all snapshots to create canonical ChapterUnitPacks.
  interface CanonicalUnitSource {
    ctx: ResourceResolveContext;
    snapshotSha: string;
    isDefault: boolean;
  }
  const chapterPool = new Map<string, { volumeId: VolumeId; chapterId: string; unitSources: Map<string, CanonicalUnitSource> }>();
  const symbolsCache = new Map<string, Map<string, XrefTargetInfo>>();
  const unitPrevId = new Map<string, string>();

  const getSymbolsForSnapshot = (snap: HydratedSnapshot): Map<string, XrefTargetInfo> => {
    let cached = symbolsCache.get(snap.sha);
    if (!cached) {
      cached = buildSnapshotSymbols(snap);
      symbolsCache.set(snap.sha, cached);
    }
    return cached;
  };

  const snapshotBySha = new Map<string, HydratedSnapshot>();
  for (const { sha } of existingSnapshotPaths) {
    const snap =
      defaultSnap && sha === defaultSnap.sha
        ? defaultSnap
        : readHydratedSnapshot(options.dataDir, sha, chapterManifestCache);
    // Keep only needed snapshots cached if few, or re-read in Pass 2 if many
    if (existingSnapshotPaths.length <= 64 || sha === defaultSha) {
      snapshotBySha.set(sha, snap);
    }

    for (const vol of snap.volumes) {
      if (vol.title_unit_id && vol.title_prev_unit_id && !unitPrevId.has(vol.title_unit_id)) {
        unitPrevId.set(vol.title_unit_id, vol.title_prev_unit_id);
      }
      for (const chap of vol.chapters) {
        const key = `${vol.id}/${chap.id}`;
        let poolEntry = chapterPool.get(key);
        if (!poolEntry) {
          poolEntry = {
            volumeId: vol.id,
            chapterId: chap.id,
            unitSources: new Map(),
          };
          chapterPool.set(key, poolEntry);
        }

        const isDef = sha === defaultSha;
        const recordSrc = (unitId: string, originHint: string) => {
          const prev = poolEntry!.unitSources.get(unitId);
          if (prev?.isDefault && !isDef) return;
          poolEntry!.unitSources.set(unitId, {
            ctx: {
              snapshotSha: snap.sha,
              volumeId: vol.id,
              chapterSourcePath: chap.source_path,
              originHint,
            },
            snapshotSha: snap.sha,
            isDefault: isDef,
          });
        };

        if (chap.title_unit_id) {
          recordSrc(chap.title_unit_id, chap.source_path);
        }
        for (const sec of chap.sections) {
          const hint = `${chap.source_path}#${sec.id}`;
          if (sec.heading_unit_id) {
            recordSrc(sec.heading_unit_id, hint);
            if (sec.heading_prev_unit_id && !unitPrevId.has(sec.heading_unit_id)) {
              unitPrevId.set(sec.heading_unit_id, sec.heading_prev_unit_id);
            }
          }
          for (const b of sec.blocks) {
            recordSrc(b.unit_id, hint);
            if (b.prev_unit_id && !unitPrevId.has(b.unit_id)) {
              unitPrevId.set(b.unit_id, b.prev_unit_id);
            }
          }
        }
      }
    }
  }

  const readSnap = (sha: string): HydratedSnapshot =>
    snapshotBySha.get(sha) ?? readHydratedSnapshot(options.dataDir, sha, chapterManifestCache);

  const packByChapterKey = new Map<
    string,
    { packHash: string; canonicalUnits: Map<string, RenderedUnit> }
  >();
  const writtenPacks = new Set<string>();

  for (const [chapKey, entry] of chapterPool) {
    const canonicalUnitsRecord: Record<string, RenderedUnit> = {};
    const canonicalUnits = new Map<string, RenderedUnit>();

    for (const unitId of [...entry.unitSources.keys()].sort()) {
      const src = entry.unitSources.get(unitId)!;
      const unit = unitMap.get(unitId);
      if (!unit) continue;

      const isDyn = dynamicUnits.has(unitId);
      const snapMeta = existingSnapshotPaths.find((s) => s.sha === src.snapshotSha);
      const symbols =
        isDyn && snapMeta
          ? getSymbolsForSnapshot(readSnap(snapMeta.sha))
          : new Map<string, XrefTargetInfo>();

      const enHtml = isDyn
        ? renderForSnapshot(unit.en, unit.kind, src.ctx, "en", symbols)
        : getRenderedHtml(unit.en, unit.kind);
      const zhRaw = getTranslatedZh(unit);
      const zhHtml =
        unit.translatable && zhRaw
          ? isDyn
            ? renderForSnapshot(zhRaw, unit.kind, src.ctx, "zh", symbols)
            : getRenderedHtml(zhRaw, unit.kind)
          : undefined;

      const prevUnitId = unitPrevId.get(unit.unit_id);
      const rendered: RenderedUnit = {
        unit_id: unit.unit_id,
        kind: unit.kind,
        translatable: unit.translatable,
        ...(unit.translatable ? { status: unit.status } : {}),
        ...(prevUnitId ? { prev_unit_id: prevUnitId } : {}),
        en_html: enHtml,
        ...(zhHtml !== undefined ? { zh_html: zhHtml } : {}),
      };
      canonicalUnitsRecord[unitId] = rendered;
      canonicalUnits.set(unitId, rendered);
    }

    const packContent = {
      volume_id: entry.volumeId,
      chapter_id: entry.chapterId,
      units: canonicalUnitsRecord,
    };
    const packHash = shortShaHash(packContent);
    if (!writtenPacks.has(packHash)) {
      const pack: ChapterUnitPack = ChapterUnitPackSchema.parse({
        pack_hash: packHash,
        ...packContent,
      });
      writeFileSync(join(packsDir, `${packHash}.json`), `${JSON.stringify(pack)}\n`, "utf8");
      writtenPacks.add(packHash);
    }
    packByChapterKey.set(chapKey, { packHash, canonicalUnits });
  }

  // Pass 2: Build ChapterStructures, SiteTrees, AnchorIndex, and collect UnitMeta history.
  const directUpstreamEventsByUnit = new Map<string, UnitUpstreamRef[]>();
  const everSeenUnitIds = new Set<string>();
  const unitOriginHint = new Map<string, string>();
  const commitOrderBySha = new Map<string, number>();

  const defaultAnchors: Record<string, AnchorTarget> = {};
  const fallbackAnchors: Record<string, AnchorTarget> = {};
  const writtenChapters = new Set<string>();
  const writtenTrees = new Set<string>();
  const siteSnapshots: SiteSnapshot[] = [];
  let defaultVolumes: SiteVolume[] = [];
  let defaultTreeHash = "";

  vlog(
    1,
    `build-site: building trees & chapter structures across ${existingSnapshotPaths.length} snapshot(s)`,
  );
  const buildBar = createProgress({
    label: "Building site artifacts",
    total: existingSnapshotPaths.length,
  });

  try {
    for (let snapIdx = 0; snapIdx < existingSnapshotPaths.length; snapIdx++) {
      const { sha } = existingSnapshotPaths[snapIdx];
      commitOrderBySha.set(sha, snapIdx);
      const snap = readSnap(sha);
      const isDefault = snap.sha === defaultSha;
      const snapSymbols = getSymbolsForSnapshot(snap);

      const seenInSnapshot = new Set<string>();
      const recordedEventInSnapshot = new Set<string>();

      let translatableCount = 0;
      let approvedTranslatableCount = 0;

      const recordUnitUsage = (
        unitId: string,
        hint: string,
        prevUnitIdFromRef?: string,
        diffStatus?: DiffStatus,
        movedFrom?: string,
      ) => {
        if (hint && !unitOriginHint.has(unitId)) {
          unitOriginHint.set(unitId, hint);
        }
        if (prevUnitIdFromRef && !unitPrevId.has(unitId)) {
          unitPrevId.set(unitId, prevUnitIdFromRef);
        }
        if (!seenInSnapshot.has(unitId)) {
          seenInSnapshot.add(unitId);
          const unit = unitMap.get(unitId);
          if (unit?.translatable) {
            translatableCount++;
            if (unit.status === "approved" && unit.zh.trim().length > 0) {
              approvedTranslatableCount++;
            }
          }
        }

        const firstSeen = !everSeenUnitIds.has(unitId);
        let changeKind: UpstreamChangeKind | null = null;
        if (snap.is_baseline) {
          if (firstSeen) {
            changeKind = "baseline";
          }
        } else if (diffStatus === "modified") {
          changeKind = "modified";
        } else if (diffStatus === "moved") {
          changeKind = "moved";
        } else if (diffStatus === "added" || firstSeen) {
          changeKind = "added";
        }

        if (changeKind && !recordedEventInSnapshot.has(unitId)) {
          recordedEventInSnapshot.add(unitId);
          let history = directUpstreamEventsByUnit.get(unitId);
          if (!history) {
            history = [];
            directUpstreamEventsByUnit.set(unitId, history);
          }
          history.push({
            sha: snap.sha,
            date: snap.date,
            title: snap.title,
            ratified_tag: snap.ratified_tag,
            change_kind: changeKind,
            unit_id: unitId,
            ...(prevUnitIdFromRef ? { prev_unit_id: prevUnitIdFromRef } : {}),
            ...(movedFrom ? { moved_from: movedFrom } : {}),
          });
        }
      };

      const recordAnchor = (anchorKey: string | undefined, target: AnchorTarget) => {
        if (!anchorKey) return;
        const bucket = isDefault ? defaultAnchors : fallbackAnchors;
        if (!bucket[anchorKey]) {
          bucket[anchorKey] = target;
        }
      };

      const siteVolumes: SiteVolume[] = [];

      for (const vol of snap.volumes) {
        if (vol.title_unit_id) {
          recordUnitUsage(
            vol.title_unit_id,
            vol.entry_file,
            vol.title_prev_unit_id,
            vol.title_prev_unit_id ? "modified" : undefined,
          );
        }

        const siteChapters: SiteChapterEntry[] = [];

        for (const chap of vol.chapters) {
          const chapKey = `${vol.id}/${chap.id}`;
          const packInfo = packByChapterKey.get(chapKey)!;

          recordAnchor(chap.id, {
            volume_id: vol.id,
            chapter_id: chap.id,
            ...(chap.sections[0] ? { section_id: chap.sections[0].id } : {}),
            anchor_id: chap.id,
          });

          const chapTitleUnit = chap.title_unit_id ? unitMap.get(chap.title_unit_id) : undefined;
          const chapTitleEn =
            (chapTitleUnit ? cleanPlainHeadingTitle(chapTitleUnit.en) : "") ||
            cleanPlainHeadingTitle(chap.title_en) ||
            chap.title_en;
          const chapTitleZhRaw = getTranslatedZh(chapTitleUnit);
          const chapTitleZh = chapTitleZhRaw
            ? cleanPlainHeadingTitle(chapTitleZhRaw) || chapTitleEn
            : chapTitleEn;

          let changedBlocksInChap = snap.deleted_blocks.filter(
            (d) => d.chapter_key === chapKey,
          ).length;
          const siteSections: SiteSectionNode[] = [];
          for (const sec of chap.sections) {
            if (sec.heading_diff_status) changedBlocksInChap++;
            for (const b of sec.blocks) {
              if (b.diff_status) changedBlocksInChap++;
            }
            const hint = `${chap.source_path}#${sec.id}`;
            if (sec.heading_unit_id) {
              recordUnitUsage(
                sec.heading_unit_id,
                hint,
                sec.heading_prev_unit_id,
                sec.heading_diff_status,
                sec.heading_moved_from,
              );
            }
            for (const b of sec.blocks) {
              recordUnitUsage(b.unit_id, hint, b.prev_unit_id, b.diff_status, b.moved_from);
            }

            const secTarget: AnchorTarget = {
              volume_id: vol.id,
              chapter_id: chap.id,
              section_id: sec.id,
              anchor_id: sec.id,
            };
            recordAnchor(sec.id, secTarget);
            recordAnchor(sec.heading_anchor_id, secTarget);
            if (sec.heading_extra_anchors) {
              for (const extra of sec.heading_extra_anchors) {
                recordAnchor(extra, secTarget);
              }
            }

            for (const b of sec.blocks) {
              const u = unitMap.get(b.unit_id);
              const extras = [
                ...(b.extra_anchors ?? []),
                ...(u ? extractExtraAnchors(u.en, b.anchor_id) : []),
              ];
              if (b.anchor_id) {
                recordAnchor(b.anchor_id, {
                  volume_id: vol.id,
                  chapter_id: chap.id,
                  section_id: sec.id,
                  anchor_id: b.anchor_id,
                });
              }
              for (const extra of extras) {
                recordAnchor(extra, {
                  volume_id: vol.id,
                  chapter_id: chap.id,
                  section_id: sec.id,
                  anchor_id: extra,
                });
              }
            }

            const headingUnit = sec.heading_unit_id ? unitMap.get(sec.heading_unit_id) : undefined;
            const secTitleEn =
              (headingUnit ? cleanPlainHeadingTitle(headingUnit.en) : "") ||
              cleanPlainHeadingTitle(sec.title) ||
              sec.title;
            const secTitleZhRaw = getTranslatedZh(headingUnit);
            const secTitleZh = secTitleZhRaw
              ? cleanPlainHeadingTitle(secTitleZhRaw) || secTitleEn
              : secTitleEn;

            const headingExtras = sec.heading_extra_anchors?.filter((a) => a.length > 0);
            siteSections.push({
              id: sec.id,
              level: sec.level,
              sectnum: sec.sectnum ?? null,
              title_en: secTitleEn,
              title_zh: secTitleZh,
              ...(sec.heading_unit_id ? { heading_unit_id: sec.heading_unit_id } : {}),
              ...(sec.heading_anchor_id ? { heading_anchor_id: sec.heading_anchor_id } : {}),
              ...(headingExtras && headingExtras.length > 0
                ? { heading_extra_anchors: headingExtras }
                : {}),
              blocks: sec.blocks.map((b) =>
                compactBlockEntry({
                  unit_id: b.unit_id,
                  anchor_id: b.anchor_id,
                  extra_anchors: b.extra_anchors,
                }),
              ),
            });
          }

          if (chap.title_unit_id) {
            recordUnitUsage(chap.title_unit_id, chap.source_path);
          }

          // Compute snapshot-specific HTML overrides only for dynamic units that differ from the pack.
          const unitOverrides: Record<string, UnitHtmlOverride> = {};
          const renderCtx: ResourceResolveContext = {
            snapshotSha: snap.sha,
            volumeId: vol.id,
            chapterSourcePath: chap.source_path,
          };

          for (const unitId of buildChapterRenderableIds(chap)) {
            if (!dynamicUnits.has(unitId)) continue;
            const unit = unitMap.get(unitId);
            const canonical = packInfo.canonicalUnits.get(unitId);
            if (!unit || !canonical) continue;

            const enHtmlSnap = renderForSnapshot(unit.en, unit.kind, renderCtx, "en", snapSymbols);
            const zhRaw = getTranslatedZh(unit);
            const zhHtmlSnap =
              unit.translatable && zhRaw
                ? renderForSnapshot(zhRaw, unit.kind, renderCtx, "zh", snapSymbols)
                : undefined;

            if (
              enHtmlSnap !== canonical.en_html ||
              (zhHtmlSnap ?? "") !== (canonical.zh_html ?? "")
            ) {
              unitOverrides[unitId] = {
                en_html: enHtmlSnap,
                ...(zhHtmlSnap !== undefined ? { zh_html: zhHtmlSnap } : {}),
              };
            }
          }

          const hasOverrides = Object.keys(unitOverrides).length > 0;
          const chapterContent = {
            volume_id: vol.id,
            chapter_id: chap.id,
            sectname: chap.sectname ?? "chapter",
            sectnum: chap.sectnum ?? null,
            title_en: chapTitleEn,
            title_zh: chapTitleZh,
            ...(chap.title_unit_id ? { title_unit_id: chap.title_unit_id } : {}),
            sections: siteSections,
            ...(hasOverrides ? { unit_overrides: unitOverrides } : {}),
          };
          const structHash = shortShaHash(chapterContent);
          if (!writtenChapters.has(structHash)) {
            vlog(2, `chapter ${snap.sha.slice(0, 8)} ${chapKey} -> ${structHash}.json`);
            const chapterStruct: ChapterStructure = ChapterStructureSchema.parse({
              struct_hash: structHash,
              ...chapterContent,
            });
            writeFileSync(
              join(chaptersDir, `${structHash}.json`),
              `${JSON.stringify(chapterStruct)}\n`,
              "utf8",
            );
            writtenChapters.add(structHash);
          }

          siteChapters.push({
            id: chap.id,
            sectname: chap.sectname ?? "chapter",
            sectnum: chap.sectnum ?? null,
            title_en: chapTitleEn,
            title_zh: chapTitleZh,
            struct_hash: structHash,
            pack_hash: packInfo.packHash,
            ...(snap.parent_sha && !snap.is_baseline && changedBlocksInChap > 0
              ? { changed_blocks: changedBlocksInChap }
              : {}),
          });
        }

        const { titleEn: volTitleEn, titleZh: volTitleZh } = resolveVolumeTitles(vol, unitMap);
        siteVolumes.push({
          id: vol.id,
          title_en: volTitleEn,
          title_zh: volTitleZh,
          chapters: siteChapters,
        });
      }

      for (const unitId of seenInSnapshot) {
        everSeenUnitIds.add(unitId);
      }

      const treeHash = shortShaHash(siteVolumes);
      if (!writtenTrees.has(treeHash)) {
        const tree: SiteTree = SiteTreeSchema.parse({
          tree_hash: treeHash,
          volumes: siteVolumes,
        });
        writeFileSync(join(treesDir, `${treeHash}.json`), `${JSON.stringify(tree)}\n`, "utf8");
        writtenTrees.add(treeHash);
      }

      if (isDefault) {
        defaultVolumes = siteVolumes;
        defaultTreeHash = treeHash;
      }

      const approvalRatio =
        translatableCount === 0
          ? 1
          : Number((approvedTranslatableCount / translatableCount).toFixed(4));

      siteSnapshots.push({
        sha: snap.sha,
        parent_sha: snap.parent_sha,
        is_baseline: snap.is_baseline,
        date: snap.date,
        title: snap.title,
        ratified_tag: snap.ratified_tag,
        draft_tags: snap.draft_tags,
        diff: snap.diff,
        approval_ratio: approvalRatio,
        tree_hash: treeHash,
      });
      buildBar.increment(snap.sha.slice(0, 7));
    }
    buildBar.done();
  } finally {
    buildBar.clear();
  }

  if (!defaultTreeHash && siteSnapshots.length > 0) {
    const lastSnap = siteSnapshots[siteSnapshots.length - 1];
    defaultTreeHash = lastSnap.tree_hash;
  }

  const siteIndex: SiteIndex = SiteIndexSchema.parse({
    generated_at: new Date().toISOString(),
    data_repo_url: dataRepoUrl,
    upstream_repo_url: upstreamRepoUrl,
    glossary_markdown: glossaryMarkdown,
    default_sha: defaultSha,
    default_tree_hash: defaultTreeHash,
    default_volumes: defaultVolumes,
    snapshots: siteSnapshots,
  });
  writeFileSync(join(options.outDir, "index.json"), `${JSON.stringify(siteIndex, null, 2)}\n`, "utf8");

  // Write anchors.json (default snapshot entries win over historical fallbacks)
  const mergedAnchors = AnchorIndexSchema.parse({
    anchors: { ...fallbackAnchors, ...defaultAnchors },
  });
  writeFileSync(join(options.outDir, "anchors.json"), `${JSON.stringify(mergedAnchors)}\n`, "utf8");

  // Write unit metadata shards (<outDir>/meta/<2-hex>.json)
  const allUnitIds = new Set<string>([...unitMap.keys(), ...everSeenUnitIds]);
  const shards = new Map<string, Record<string, UnitMeta>>();

  const buildChainedUpstreamHistory = (startUnitId: string): UnitUpstreamRef[] => {
    const result: UnitUpstreamRef[] = [];
    const seenKeys = new Set<string>();
    const visitedUnits = new Set<string>();
    let cur: string | undefined = startUnitId;
    while (cur && !visitedUnits.has(cur)) {
      visitedUnits.add(cur);
      const direct = directUpstreamEventsByUnit.get(cur);
      if (direct) {
        for (let i = direct.length - 1; i >= 0; i--) {
          const ref = direct[i];
          const key = `${ref.sha}:${ref.unit_id}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            result.push(ref);
          }
        }
      }
      cur = unitPrevId.get(cur);
    }
    result.sort(
      (a, b) => (commitOrderBySha.get(b.sha) ?? -1) - (commitOrderBySha.get(a.sha) ?? -1),
    );
    return result;
  };

  for (const unitId of allUnitIds) {
    const prefix = unitId.slice(0, 2);
    if (!shards.has(prefix)) shards.set(prefix, {});
    const unit = unitMap.get(unitId);
    const prevId = unitPrevId.get(unitId);
    const originHint = unitOriginHint.get(unitId);
    const zhRaw = getTranslatedZh(unit);
    shards.get(prefix)![unitId] = {
      unit_id: unitId,
      kind: unit?.kind ?? "paragraph",
      translatable: unit?.translatable ?? true,
      ...(unit?.translatable ? { status: unit.status } : {}),
      en_raw: unit?.en ?? "",
      ...(zhRaw ? { zh_raw: zhRaw } : {}),
      ...(originHint ? { origin_hint: originHint } : {}),
      ...(prevId ? { prev_unit_id: prevId } : {}),
      upstream_history: buildChainedUpstreamHistory(unitId),
      revisions: revisionsByUnit.get(unitId) ?? [],
    };
  }

  vlog(1, `build-site: writing ${shards.size} meta shard(s)`);
  for (const [prefix, shardData] of shards) {
    if (isVerbose(3)) vlog(3, `shard ${prefix}.json (${Object.keys(shardData).length} units)`);
    writeFileSync(join(metaDir, `${prefix}.json`), `${JSON.stringify(shardData)}\n`, "utf8");
  }

  // Write search.json from default snapshot
  const searchEntries: SearchEntry[] = [];
  if (defaultSnap) {
    const defaultSymbols = getSymbolsForSnapshot(defaultSnap);
    const xrefTitlesEn = new Map<string, string>();
    const xrefTitlesZh = new Map<string, string>();
    for (const [k, info] of defaultSymbols) {
      if (info.title_en) xrefTitlesEn.set(k, info.title_en);
      if (info.title_zh) xrefTitlesZh.set(k, info.title_zh);
    }

    const chapTitles = new Map<
      HydratedSnapshot["volumes"][number]["chapters"][number],
      { titleEn: string; titleZh: string }
    >();
    const secTitles = new Map<
      HydratedSnapshot["volumes"][number]["chapters"][number]["sections"][number],
      { titleEn: string; titleZh: string }
    >();

    for (const vol of defaultSnap.volumes) {
      for (const chap of vol.chapters) {
        const titleUnit = chap.title_unit_id ? unitMap.get(chap.title_unit_id) : undefined;
        const chapTitleEn =
          (titleUnit
            ? htmlToPlainText(
                rewriteHtmlXrefs(getRenderedHtml(titleUnit.en, titleUnit.kind), "en", defaultSymbols),
                titleUnit.kind,
                { xrefTitles: xrefTitlesEn },
              )
            : "") ||
          cleanPlainHeadingTitle(chap.title_en) ||
          chap.title_en;
        const chapTitleZhRaw = getTranslatedZh(titleUnit);
        const chapTitleZh = chapTitleZhRaw
          ? htmlToPlainText(
              rewriteHtmlXrefs(getRenderedHtml(chapTitleZhRaw, titleUnit!.kind), "zh", defaultSymbols),
              titleUnit!.kind,
              { xrefTitles: xrefTitlesZh },
            ) || chapTitleEn
          : chapTitleEn;
        chapTitles.set(chap, { titleEn: chapTitleEn, titleZh: chapTitleZh });

        for (const sec of chap.sections) {
          const headingUnit = sec.heading_unit_id ? unitMap.get(sec.heading_unit_id) : undefined;
          const secTitleEn =
            (headingUnit
              ? htmlToPlainText(
                  rewriteHtmlXrefs(getRenderedHtml(headingUnit.en, "heading"), "en", defaultSymbols),
                  "heading",
                  { xrefTitles: xrefTitlesEn },
                )
              : "") ||
            cleanPlainHeadingTitle(sec.title) ||
            sec.title;
          const secTitleZhRaw = getTranslatedZh(headingUnit);
          const secTitleZh = secTitleZhRaw
            ? htmlToPlainText(
                rewriteHtmlXrefs(getRenderedHtml(secTitleZhRaw, "heading"), "zh", defaultSymbols),
                "heading",
                { xrefTitles: xrefTitlesZh },
              ) || secTitleEn
            : secTitleEn;
          secTitles.set(sec, { titleEn: secTitleEn, titleZh: secTitleZh });
        }
      }
    }

    const seenSearchUnits = new Set<string>();
    const seenSectionIds = new Set<string>();
    for (const vol of defaultSnap.volumes) {
      for (const chap of vol.chapters) {
        const chapMeta = chapTitles.get(chap) ?? {
          titleEn: chap.title_en,
          titleZh: chap.title_en,
        };
        for (const sec of chap.sections) {
          const secMeta = secTitles.get(sec) ?? {
            titleEn: sec.title,
            titleZh: sec.title,
          };

          const indexableRefs: Array<{
            unit_id: string;
            anchor_id?: string;
            extra_anchors?: string[];
          }> = [];
          if (sec.heading_unit_id) {
            indexableRefs.push({
              unit_id: sec.heading_unit_id,
              anchor_id: sec.heading_anchor_id,
              extra_anchors: sec.heading_extra_anchors,
            });
          }
          for (const b of sec.blocks) {
            indexableRefs.push(b);
          }

          for (const item of indexableRefs) {
            if (seenSearchUnits.has(item.unit_id)) continue;
            seenSearchUnits.add(item.unit_id);
            const unit = unitMap.get(item.unit_id);
            if (!unit) continue;

            const enHtml = rewriteHtmlXrefs(
              getRenderedHtml(unit.en, unit.kind),
              "en",
              defaultSymbols,
            );
            const zhRaw = getTranslatedZh(unit);
            const hasZh = unit.translatable && zhRaw.length > 0;
            const zhHtml = !hasZh
              ? ""
              : zhRaw === unit.en
                ? enHtml
                : rewriteHtmlXrefs(getRenderedHtml(zhRaw, unit.kind), "zh", defaultSymbols);
            const en = htmlToPlainText(enHtml, unit.kind, {
              xrefTitles: xrefTitlesEn,
            });
            const zh = !unit.translatable
              ? en
              : !hasZh
                ? ""
                : htmlToPlainText(zhHtml, unit.kind, {
                    xrefTitles: xrefTitlesZh,
                  });

            const extraAnchors = [
              ...new Set([
                ...(item.extra_anchors ?? []),
                ...extractExtraAnchors(unit.en, item.anchor_id),
              ]),
            ];

            if (
              !en &&
              !zh &&
              !item.anchor_id &&
              extraAnchors.length === 0 &&
              seenSectionIds.has(sec.id)
            ) {
              continue;
            }
            seenSectionIds.add(sec.id);

            const symbols = extractCodeSymbols(enHtml);
            const hasSubSection = sec.level >= 2;

            searchEntries.push({
              unit_id: unit.unit_id,
              volume_id: vol.id,
              chapter_id: chap.id,
              section_id: sec.id,
              chapter_title: chapMeta.titleEn,
              chapter_title_zh: chapMeta.titleZh,
              ...(hasSubSection
                ? {
                    section_title: secMeta.titleEn,
                    section_title_zh: secMeta.titleZh,
                  }
                : {}),
              kind: unit.kind,
              en,
              zh,
              ...(symbols.length > 0 ? { symbols } : {}),
              ...(item.anchor_id ? { anchor_id: item.anchor_id } : {}),
              ...(extraAnchors.length > 0 ? { extra_anchors: extraAnchors } : {}),
            });
          }
        }
      }
    }
  }

  writeFileSync(join(options.outDir, "search.json"), `${JSON.stringify(searchEntries)}\n`, "utf8");

  return {
    snapshots: siteSnapshots.length,
    trees: writtenTrees.size,
    chapters: writtenChapters.size,
    packs: writtenPacks.size,
    units: allUnitIds.size,
  };
}
