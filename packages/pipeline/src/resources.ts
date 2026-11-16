import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { parseBibtex, type BibEntry } from "./parser/bibtex.ts";

export const IMAGE_EXT_RE = /\.(?:png|svg|jpe?g|gif|webp|bmp|avif)$/i;

const GIT_IMAGE_PATHSPECS = [
  ":(icase)*.png",
  ":(icase)*.svg",
  ":(icase)*.jpg",
  ":(icase)*.jpeg",
  ":(icase)*.gif",
  ":(icase)*.webp",
  ":(icase)*.bmp",
  ":(icase)*.avif",
];

const EXTERNAL_OR_REWRITTEN_SRC_RE = /^(?:data:|https?:|\/\/|\/|\.?\/data\/assets\/)/i;
const IMG_SRC_ATTR_RE = /(<img\b[^>]*?\bsrc=["'])([^"']+)(["'])/gi;

/**
 * Upstream image resource manifest across synced snapshots.
 */
export interface ResourceManifest {
  version: 1;
  latest_sha: string;
  /** Distinct image trees (`repoPath -> blobSha`). `trees[0]` is always `latest_sha`'s tree. */
  trees: Array<Record<string, string>>;
  /** Maps snapshot SHA -> index in `trees` (omitted entries default to `0`). */
  snapshot_tree_index: Record<string, number>;
}

export interface ResourceResolveContext {
  snapshotSha?: string;
  volumeId?: string;
  chapterSourcePath?: string;
  originHint?: string;
}

interface CompiledTree {
  files: Map<string, string>;
  byBasename: Map<string, string[]>;
}

function isGitDirectory(dir: string): boolean {
  return existsSync(join(dir, ".git")) || existsSync(join(dir, "HEAD"));
}

function spawnGitText(args: string[], cwd: string): { ok: boolean; stdout: string } {
  const res = Bun.spawnSync(["git", "-c", "core.quotepath=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: res.exitCode === 0,
    stdout: res.exitCode === 0 ? res.stdout.toString("utf8") : "",
  };
}

function normalizeRepoPath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function sortedRecord(entries: Iterable<[string, string]>): Record<string, string> {
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: Record<string, string> = {};
  for (const [k, v] of sorted) out[k] = v;
  return out;
}

function treeSignature(tree: Record<string, string>): string {
  const h = createHash("sha256");
  for (const k of Object.keys(tree).sort()) {
    h.update(k);
    h.update("\0");
    h.update(tree[k]);
    h.update("\n");
  }
  return h.digest("hex");
}

function readGitImageTree(upstreamDir: string, commitSha: string): Record<string, string> | null {
  const res = Bun.spawnSync(["git", "-c", "core.quotepath=false", "ls-tree", "-r", "-z", commitSha], {
    cwd: upstreamDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) return null;
  const raw = res.stdout.toString("utf8");
  const entries: Array<[string, string]> = [];
  for (const rec of raw.split("\0")) {
    if (!rec) continue;
    const tabIdx = rec.indexOf("\t");
    if (tabIdx < 0) continue;
    const meta = rec.slice(0, tabIdx);
    const repoPath = normalizeRepoPath(rec.slice(tabIdx + 1));
    if (!IMAGE_EXT_RE.test(repoPath)) continue;
    const parts = meta.trim().split(/\s+/);
    const type = parts[1];
    const blobSha = parts[2];
    if (type === "blob" && blobSha) {
      entries.push([repoPath, blobSha]);
    }
  }
  return sortedRecord(entries);
}

/**
 * Computes the canonical 40-char lowercase hex Git blob SHA-1 for `content`.
 */
export function gitBlobSha1(content: Uint8Array | string): string {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return createHash("sha1")
    .update(`blob ${buf.byteLength}\0`)
    .update(buf)
    .digest("hex");
}

/**
 * Formats the content-addressed filename (`<16-hex-sha><lowercase-ext>`) for a blob.
 */
export function contentAddressedAssetName(blobSha: string, repoPath: string): string {
  const ext = posix.extname(normalizeRepoPath(repoPath)).toLowerCase();
  return `${blobSha.slice(0, 16)}${ext}`;
}

/**
 * Formats an immutable raw file URL pointing to `repoPath` at `sha` on the upstream host.
 */
export function formatUpstreamRawUrl(
  upstreamRepoUrl: string,
  sha: string,
  repoPath: string,
): string {
  const cleanRepo = upstreamRepoUrl.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const encodedPath = normalizeRepoPath(repoPath)
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const ghMatch = cleanRepo.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (ghMatch) {
    return `https://raw.githubusercontent.com/${ghMatch[1]}/${ghMatch[2]}/${sha}/${encodedPath}`;
  }
  return `${cleanRepo}/raw/${sha}/${encodedPath}`;
}

function compileTree(record: Record<string, string>): CompiledTree {
  const files = new Map<string, string>();
  const byBasename = new Map<string, string[]>();
  for (const repoPath of Object.keys(record).sort()) {
    const blobSha = record[repoPath];
    files.set(repoPath, blobSha);
    const base = posix.basename(repoPath);
    const list = byBasename.get(base);
    if (list) list.push(repoPath);
    else byBasename.set(base, [repoPath]);
  }
  return { files, byBasename };
}

function extractDirHint(pathOrHint?: string): string {
  if (!pathOrHint) return "";
  const docPath = pathOrHint.split(/[#:]/) [0].replace(/\\/g, "/");
  const dir = posix.dirname(docPath);
  return dir && dir !== "." ? dir : "";
}

/**
 * Resolves an AsciiDoc/HTML relative image `rawSrc` strictly within `tree`
 * (preserving file extension; never rewriting e.g. `.png` to `.svg`).
 */
export function resolvePathInTree(
  tree: CompiledTree,
  rawSrc: string,
  ctx: Omit<ResourceResolveContext, "snapshotSha"> = {},
): string | null {
  const cleanSrc = rawSrc.split(/[?#]/)[0].replace(/\\/g, "/").replace(/^\.\//, "");
  if (!cleanSrc) return null;

  const chapDir = extractDirHint(ctx.chapterSourcePath);
  const hintDir = extractDirHint(ctx.originHint);

  const candidates: string[] = [];
  const pushDirCandidates = (dir: string) => {
    if (!dir) return;
    candidates.push(
      posix.normalize(`${dir}/${cleanSrc}`),
      posix.normalize(`${dir}/images/${cleanSrc}`),
    );
  };

  pushDirCandidates(chapDir);
  if (hintDir && hintDir !== chapDir) {
    pushDirCandidates(hintDir);
  }
  if (ctx.volumeId) {
    candidates.push(
      posix.normalize(`src/${ctx.volumeId}/images/${cleanSrc}`),
      posix.normalize(`src/${ctx.volumeId}/${cleanSrc}`),
    );
  }
  candidates.push(
    posix.normalize(cleanSrc),
    posix.normalize(`src/${cleanSrc}`),
    posix.normalize(`src/images/${cleanSrc}`),
    posix.normalize(`images/${cleanSrc}`),
    posix.normalize(`docs-resources/images/${cleanSrc}`),
    posix.normalize(`modules/ROOT/images/${cleanSrc}`),
  );

  for (const candidate of candidates) {
    const normalized = candidate.replace(/^\/+/, "");
    if (tree.files.has(normalized)) return normalized;
  }

  const base = posix.basename(cleanSrc);
  const matches = tree.byBasename.get(base);
  if (matches && matches.length === 1) {
    return matches[0];
  }
  return null;
}

/**
 * Builds a `ResourceManifest` across `snapshotShas` (chronological: oldest -> newest)
 * from an upstream Git repository using at most 3 fast Git commands.
 */
export function buildResourceManifestFromGit(
  upstreamDir: string,
  snapshotShas: string[],
  preferredLatestSha?: string | null,
): ResourceManifest | null {
  if (!upstreamDir || !existsSync(upstreamDir) || !isGitDirectory(upstreamDir)) {
    return null;
  }

  let latestSha = "";
  const candidates = [
    preferredLatestSha?.trim(),
    snapshotShas.length > 0 ? snapshotShas[snapshotShas.length - 1] : undefined,
    "HEAD",
  ].filter((x): x is string => Boolean(x));

  for (const ref of candidates) {
    const verified = spawnGitText(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], upstreamDir);
    if (verified.ok && verified.stdout.trim()) {
      latestSha = verified.stdout.trim();
      break;
    }
  }
  if (!latestSha) return null;

  const latestFiles = readGitImageTree(upstreamDir, latestSha);
  if (!latestFiles) return null;

  const trees: Array<Record<string, string>> = [latestFiles];
  const treeIndexBySig = new Map<string, number>([[treeSignature(latestFiles), 0]]);
  const snapshotTreeIndex: Record<string, number> = {};

  const internTree = (record: Record<string, string>): number => {
    const sig = treeSignature(record);
    const existing = treeIndexBySig.get(sig);
    if (existing !== undefined) return existing;
    const idx = trees.length;
    trees.push(record);
    treeIndexBySig.set(sig, idx);
    return idx;
  };

  if (snapshotShas.length > 0) {
    const wantedSet = new Set(snapshotShas);
    const visited = new Set<string>();

    const oldestSha = snapshotShas[0];
    const oldestHasParent = spawnGitText(
      ["rev-parse", "--verify", "--quiet", `${oldestSha}^`],
      upstreamDir,
    ).ok;
    const rangeSpec = oldestHasParent ? `${oldestSha}^..${latestSha}` : latestSha;

    const chainRes = spawnGitText(["rev-list", "--first-parent", rangeSpec], upstreamDir);
    const firstParentChain = chainRes.ok
      ? chainRes.stdout
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    if (firstParentChain.length > 0 && firstParentChain[0] === latestSha) {
      const logRes = spawnGitText(
        [
          "log",
          "--first-parent",
          "-m",
          "--raw",
          "--no-abbrev",
          "--no-renames",
          "--format=COMMIT %H",
          rangeSpec,
          "--",
          ...GIT_IMAGE_PATHSPECS,
        ],
        upstreamDir,
      );

      const parentBlobsByCommit = new Map<string, Map<string, string | null>>();
      let currentCommitMap: Map<string, string | null> | null = null;

      if (logRes.ok) {
        for (const rawLine of logRes.stdout.split("\n")) {
          const line = rawLine.trim();
          if (!line) continue;
          if (line.startsWith("COMMIT ")) {
            const sha = line.slice("COMMIT ".length).trim();
            if (!parentBlobsByCommit.has(sha)) {
              currentCommitMap = new Map();
              parentBlobsByCommit.set(sha, currentCommitMap);
            } else {
              // Ignore secondary parent blocks if git ever emits more than one for a merge
              currentCommitMap = null;
            }
            continue;
          }
          if (currentCommitMap && line.startsWith(":")) {
            const tabIdx = line.indexOf("\t");
            if (tabIdx < 0) continue;
            const headerParts = line.slice(1, tabIdx).trim().split(/\s+/);
            const oldBlob = headerParts[2];
            const repoPath = normalizeRepoPath(line.slice(tabIdx + 1));
            if (!oldBlob || !IMAGE_EXT_RE.test(repoPath)) continue;
            if (!currentCommitMap.has(repoPath)) {
              currentCommitMap.set(repoPath, /^0+$/.test(oldBlob) ? null : oldBlob);
            }
          }
        }
      }

      let curRecord = latestFiles;
      let curIdx = 0;
      visited.add(firstParentChain[0]);

      for (let i = 0; i < firstParentChain.length - 1; i++) {
        const commitSha = firstParentChain[i];
        const parentSha = firstParentChain[i + 1];
        const changes = parentBlobsByCommit.get(commitSha);
        if (changes && changes.size > 0) {
          const nextEntries = new Map<string, string>(Object.entries(curRecord));
          for (const [repoPath, parentBlob] of changes) {
            if (parentBlob === null) nextEntries.delete(repoPath);
            else nextEntries.set(repoPath, parentBlob);
          }
          curRecord = sortedRecord(nextEntries);
          curIdx = internTree(curRecord);
        }
        visited.add(parentSha);
        if (wantedSet.has(parentSha) && curIdx !== 0) {
          snapshotTreeIndex[parentSha] = curIdx;
        }
      }
    }

    for (const sha of snapshotShas) {
      if (visited.has(sha)) continue;
      const fallbackTree = readGitImageTree(upstreamDir, sha);
      if (!fallbackTree) continue;
      const idx = internTree(fallbackTree);
      if (idx !== 0) {
        snapshotTreeIndex[sha] = idx;
      }
    }
  }

  const sortedSnapshotIndex: Record<string, number> = {};
  for (const sha of Object.keys(snapshotTreeIndex).sort()) {
    sortedSnapshotIndex[sha] = snapshotTreeIndex[sha];
  }

  return {
    version: 1,
    latest_sha: latestSha,
    trees,
    snapshot_tree_index: sortedSnapshotIndex,
  };
}

function walkFilesRecursive(rootDir: string, predicate: (relPath: string) => boolean): string[] {
  if (!existsSync(rootDir)) return [];
  const out: string[] = [];
  const stack = [""];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    const absDir = relDir ? join(rootDir, relDir) : rootDir;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) stack.push(relPath);
      else if (entry.isFile() && predicate(relPath)) out.push(relPath);
    }
  }
  return out.sort();
}

/**
 * Extracts BibTeX `.bib` entries from an upstream git repository (at `sha`, falling back
 * to `HEAD`) or plain directory.
 */
export function extractBibEntriesFromUpstream(
  upstreamDir: string | undefined,
  sha?: string | null,
): Map<string, BibEntry> {
  const merged = new Map<string, BibEntry>();
  if (!upstreamDir || !existsSync(upstreamDir)) return merged;

  if (isGitDirectory(upstreamDir)) {
    const refsToTry: string[] = [];
    if (sha) refsToTry.push(sha);
    if (sha !== "HEAD") refsToTry.push("HEAD");

    for (const ref of refsToTry) {
      const treeRes = Bun.spawnSync(["git", "ls-tree", "-r", "--name-only", ref], {
        cwd: upstreamDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (treeRes.exitCode !== 0) continue;
      for (const line of treeRes.stdout.toString("utf8").split("\n")) {
        const rel = line.trim();
        if (!rel.endsWith(".bib")) continue;
        const showRes = Bun.spawnSync(["git", "show", `${ref}:${rel}`], {
          cwd: upstreamDir,
          stdout: "pipe",
          stderr: "pipe",
        });
        if (showRes.exitCode === 0) {
          for (const [k, v] of parseBibtex(showRes.stdout.toString("utf8"))) {
            merged.set(k, v);
          }
        }
      }
      if (merged.size > 0) return merged;
    }
  }

  const bibFiles = walkFilesRecursive(upstreamDir, (rel) => rel.endsWith(".bib"));
  for (const rel of bibFiles) {
    for (const [k, v] of parseBibtex(readFileSync(join(upstreamDir, rel), "utf8"))) {
      merged.set(k, v);
    }
  }
  return merged;
}

export interface SiteResourceResolverOptions {
  dataDir: string;
  outDir: string;
  upstreamDir?: string;
  upstreamRepoUrl?: string;
  snapshots: Array<{ sha: string; ratified?: boolean }>;
  latestSha?: string | null;
}

export interface SiteResourceResolver {
  rewriteHtml(html: string, ctx: ResourceResolveContext): string;
  signatureForHtml(html: string, ctx: ResourceResolveContext): string;
}

/**
 * Creates the site-build resource resolver:
 * - All referenced resources across latest and historical snapshots are materialized
 *   under `<outDir>/assets/<blobSha16><ext>` and rewritten to
 *   `./data/assets/<blobSha16><ext>`.
 * - Falls back to `formatUpstreamRawUrl` only if local blob materialization fails and
 *   `upstreamRepoUrl` is configured.
 */
export function createSiteResourceResolver(
  options: SiteResourceResolverOptions,
): SiteResourceResolver {
  const noop: SiteResourceResolver = {
    rewriteHtml: (html) => html,
    signatureForHtml: () => "",
  };

  let manifest: ResourceManifest | null = null;
  let materializeHosted: ((repoPath: string, blobSha: string, dest: string) => boolean) | null =
    null;

  const hasUpstreamDir = Boolean(options.upstreamDir && existsSync(options.upstreamDir));
  const upstreamIsGit = hasUpstreamDir && isGitDirectory(options.upstreamDir!);

  if (upstreamIsGit) {
    manifest = buildResourceManifestFromGit(
      options.upstreamDir!,
      options.snapshots.map((s) => s.sha),
      options.latestSha,
    );
    if (manifest) {
      materializeHosted = (_repoPath, blobSha, dest) => {
        const res = Bun.spawnSync(["git", "cat-file", "blob", blobSha], {
          cwd: options.upstreamDir!,
          stdout: "pipe",
          stderr: "pipe",
        });
        if (res.exitCode === 0) {
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, res.stdout);
          return true;
        }
        return false;
      };
    }
  } else if (hasUpstreamDir) {
    // Plain non-git directory fixture on disk: compute real Git blob SHA-1s for content addressing.
    const relFiles = walkFilesRecursive(options.upstreamDir!, (rel) => IMAGE_EXT_RE.test(rel));
    if (relFiles.length > 0) {
      const diskRecord: Record<string, string> = {};
      const diskPathByBlob = new Map<string, string>();
      for (const rel of relFiles) {
        const buf = readFileSync(join(options.upstreamDir!, rel));
        const blobSha = gitBlobSha1(buf);
        diskRecord[rel] = blobSha;
        if (!diskPathByBlob.has(blobSha)) {
          diskPathByBlob.set(blobSha, rel);
        }
      }
      manifest = {
        version: 1,
        latest_sha: options.latestSha ?? "",
        trees: [diskRecord],
        snapshot_tree_index: {},
      };
      materializeHosted = (repoPath, blobSha, dest) => {
        const diskRel = diskPathByBlob.get(blobSha) ?? repoPath;
        const srcAbs = join(options.upstreamDir!, diskRel);
        if (!existsSync(srcAbs)) return false;
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(srcAbs, dest);
        return true;
      };
    }
  }

  if (!manifest || !materializeHosted) {
    return noop;
  }

  const activeManifest = manifest;
  const copyHosted = materializeHosted;
  const compiledTrees = activeManifest.trees.map(compileTree);
  const latestTree = compiledTrees[0];
  if (!latestTree) return noop;

  const copiedAssets = new Set<string>();
  const failedAssets = new Set<string>();
  const assetsOutDir = join(options.outDir, "assets");

  const ensureHostedAsset = (assetName: string, repoPath: string, blobSha: string): boolean => {
    if (copiedAssets.has(assetName)) return true;
    if (failedAssets.has(assetName)) return false;
    const dest = join(assetsOutDir, assetName);
    if (copyHosted(repoPath, blobSha, dest)) {
      copiedAssets.add(assetName);
      return true;
    }
    failedAssets.add(assetName);
    return false;
  };

  const getTreeForSnapshot = (snapshotSha?: string): CompiledTree => {
    if (!snapshotSha) return latestTree;
    const idx = activeManifest.snapshot_tree_index[snapshotSha] ?? 0;
    return compiledTrees[idx] ?? latestTree;
  };

  const resolveSrc = (
    rawSrc: string,
    ctx: ResourceResolveContext,
    materialize: boolean,
  ): string | null => {
    if (EXTERNAL_OR_REWRITTEN_SRC_RE.test(rawSrc)) return null;
    const tree = getTreeForSnapshot(ctx.snapshotSha);
    const repoPathAtSnap = resolvePathInTree(tree, rawSrc, ctx);
    if (!repoPathAtSnap) return null;

    const blobSha = tree.files.get(repoPathAtSnap);
    if (!blobSha) return null;

    const assetName = contentAddressedAssetName(blobSha, repoPathAtSnap);
    if (!materialize) {
      return `./data/assets/${assetName}`;
    }
    if (ensureHostedAsset(assetName, repoPathAtSnap, blobSha)) {
      return `./data/assets/${assetName}`;
    }

    const fallbackSha = ctx.snapshotSha || activeManifest.latest_sha;
    if (options.upstreamRepoUrl && fallbackSha) {
      return formatUpstreamRawUrl(options.upstreamRepoUrl, fallbackSha, repoPathAtSnap);
    }
    return null;
  };

  return {
    rewriteHtml(html: string, ctx: ResourceResolveContext): string {
      if (!html.includes("<img")) return html;
      return html.replace(IMG_SRC_ATTR_RE, (full, pre: string, src: string, post: string) => {
        const resolved = resolveSrc(src, ctx, true);
        return resolved ? `${pre}${resolved}${post}` : full;
      });
    },
    signatureForHtml(html: string, ctx: ResourceResolveContext): string {
      if (!html.includes("<img")) return "";
      const parts: string[] = [];
      IMG_SRC_ATTR_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = IMG_SRC_ATTR_RE.exec(html)) !== null) {
        const rawSrc = m[2];
        const resolved = resolveSrc(rawSrc, ctx, false) ?? rawSrc;
        parts.push(resolved);
      }
      return parts.join("|");
    },
  };
}
