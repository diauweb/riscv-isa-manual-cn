import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ManifestIndexSchema } from "@riscv-cn/schema";
import { DATA_REMOTE_TEMPLATE, isCiEnv, type AppConfig } from "../config.ts";
import { createFixtureUpstream, isFixtureCurrent } from "../dev/fixture.ts";
import { runGit, runGitOrThrow } from "../git.ts";
import { defaultLog, info, warn, type Logger } from "../log.ts";

/** True if `child` is strictly inside `parent`. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Git config entry that authenticates HTTPS GitHub access with `DATA_REPO_TOKEN`
 * (the same mechanism `actions/checkout` uses). `null` locally, where your own git
 * credentials apply.
 */
function githubAuthHeader(remote: string): { key: string; value: string } | null {
  const token = process.env.DATA_REPO_TOKEN?.trim();
  if (!token || !remote.startsWith("https://github.com/")) return null;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return { key: "http.https://github.com/.extraheader", value: `AUTHORIZATION: basic ${basic}` };
}

// ---------------------------------------------------------------------------
// Upstream
// ---------------------------------------------------------------------------

export interface EnsureUpstreamOptions {
  log?: Logger;
  /** Force a local bare mirror even if `UPSTREAM_CACHE=false` (needed by site builds). */
  requireLocal?: boolean;
}

/**
 * Makes the configured upstream available locally and returns the path/URL that
 * `sync` / `build-site` should read from.
 *
 * - `fixture`: generates the deterministic fixture repo under WORK_DIR.
 * - remote URL + cache (or `requireLocal`): maintains a bare mirror under WORK_DIR (clone once, then fetch).
 * - remote URL, no cache: returns the URL unchanged.
 * - local path: verified and returned unchanged.
 */
export function ensureUpstream(cfg: AppConfig, options: EnsureUpstreamOptions = {}): string {
  const log = options.log ?? defaultLog;

  if (cfg.upstreamKind === "fixture") {
    if (!isFixtureCurrent(cfg.upstreamFixtureDir)) {
      info(`upstream: generating fixture at ${cfg.upstreamFixtureDir}`, log);
      createFixtureUpstream(cfg.upstreamFixtureDir);
    }
    return cfg.upstreamFixtureDir;
  }

  if (cfg.upstreamKind === "local") {
    if (!existsSync(cfg.upstreamRepo)) {
      throw new Error(`UPSTREAM_REPO path does not exist: ${cfg.upstreamRepo}`);
    }
    return cfg.upstreamRepo;
  }

  if (!cfg.upstreamCache && !options.requireLocal) return cfg.upstreamRepo;

  const mirror = cfg.upstreamMirrorDir;
  if (!existsSync(join(mirror, "HEAD"))) {
    info(`upstream: mirroring ${cfg.upstreamRepo} → ${mirror} (one-time)`, log);
    rmSync(mirror, { recursive: true, force: true });
    mkdirSync(dirname(mirror), { recursive: true });
    runGitOrThrow(["clone", "--quiet", "--mirror", cfg.upstreamRepo, mirror]);
  } else {
    info(`upstream: fetching ${cfg.upstreamRepo}`, log);
    runGitOrThrow(["remote", "set-url", "origin", cfg.upstreamRepo], mirror);
    runGitOrThrow(["fetch", "--quiet", "--prune", "--prune-tags", "--force", "origin"], mirror);
  }
  return mirror;
}

// ---------------------------------------------------------------------------
// Data repository
// ---------------------------------------------------------------------------

export function templateDir(cfg: Pick<AppConfig, "repoRoot">): string {
  return join(cfg.repoRoot, "templates", "data-repo");
}

/** Configures a commit identity inside `dir` only if git has none (fresh CI runners). */
export function ensureGitIdentity(dir: string): void {
  const email = runGit(["config", "user.email"], dir).stdout.trim();
  if (email) return;
  const ci = isCiEnv();
  runGitOrThrow(["config", "user.name", ci ? "github-actions[bot]" : "riscv-isa-manual-cn dev"], dir);
  runGitOrThrow(
    ["config", "user.email", ci ? "41898282+github-actions[bot]@users.noreply.github.com" : "dev@localhost"],
    dir,
  );
}

function isInitialisedDataRepo(dir: string): boolean {
  return existsSync(join(dir, "manifests", "index.json")) && existsSync(join(dir, "GLOSSARY.md"));
}

export interface EnsureDataResult {
  dataDir: string;
  created: boolean;
  source: string;
}

/**
 * Makes `DATA_DIR` a usable data repository:
 * - already initialised → left untouched;
 * - `DATA_REMOTE` is a URL/path → `git clone` (authenticated with DATA_REPO_TOKEN in CI);
 * - `DATA_REMOTE=template` → initialised from `templates/data-repo/` with one commit.
 */
export function ensureData(cfg: AppConfig, log: Logger = defaultLog): EnsureDataResult {
  const dir = cfg.dataDir;
  if (isInitialisedDataRepo(dir)) {
    if (existsSync(join(dir, ".git"))) ensureGitIdentity(dir);
    return { dataDir: dir, created: false, source: "existing" };
  }
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(
      `DATA_DIR exists but is not an initialised data repository (missing manifests/index.json or GLOSSARY.md): ${dir}`,
    );
  }

  mkdirSync(dirname(dir), { recursive: true });

  let source: string;
  if (cfg.dataRemote !== DATA_REMOTE_TEMPLATE) {
    info(`data: cloning ${cfg.dataRemote} → ${dir}`, log);
    const auth = githubAuthHeader(cfg.dataRemote);
    runGitOrThrow([...(auth ? ["-c", `${auth.key}=${auth.value}`] : []), "clone", "--quiet", cfg.dataRemote, dir]);
    // Persist auth in this throwaway clone so `publish:data` can push (CI only).
    if (auth) runGitOrThrow(["config", auth.key, auth.value], dir);
    source = cfg.dataRemote;
  } else {
    info(`data: initialising ${dir} from templates/data-repo`, log);
    mkdirSync(dir, { recursive: true });
    runGitOrThrow(["init", "--quiet", "-b", "main"], dir);
    runGitOrThrow(["config", "commit.gpgsign", "false"], dir);
    source = DATA_REMOTE_TEMPLATE;
  }

  ensureGitIdentity(dir);
  // A template init, or a clone of a brand-new empty data repository, needs seeding.
  if (!isInitialisedDataRepo(dir)) {
    seedFromTemplate(cfg, dir);
    runGitOrThrow(["add", "-A"], dir);
    runGitOrThrow(["commit", "--quiet", "-m", "chore: initialize data repository from template"], dir);
  }
  return { dataDir: dir, created: true, source };
}

function seedFromTemplate(cfg: AppConfig, dir: string): void {
  const tpl = templateDir(cfg);
  if (!existsSync(tpl)) throw new Error(`Data repository template not found: ${tpl}`);
  cpSync(tpl, dir, { recursive: true, force: false, errorOnExist: false });

  const indexPath = join(dir, "manifests", "index.json");
  const raw = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : {};
  const index = ManifestIndexSchema.parse({
    upstream_repo:
      cfg.upstreamKind === "fixture"
        ? "fixture"
        : cfg.upstreamKind === "remote"
          ? cfg.upstreamRepo
          : cfg.upstreamRepoUrl,
    baseline_cutoff: cfg.baselineDate ?? raw.baseline_cutoff ?? "2023-06-01",
    last_synced_sha: null,
    known_tags: {},
    commits: [],
  });
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

export interface ResetDataOptions {
  yes?: boolean;
}

/**
 * Deletes and re-creates DATA_DIR.
 *
 * Refuses to touch anything outside WORK_DIR unless it is already an
 * initialised data repository and `options.yes` is set. Preserves any
 * existing `origin` git remote when re-creating from the template.
 */
export function resetData(
  cfg: AppConfig,
  log: Logger = defaultLog,
  options: ResetDataOptions = {},
): EnsureDataResult {
  if (!existsSync(cfg.dataDir)) {
    return ensureData(cfg, log);
  }
  if (!isInside(cfg.dataDir, cfg.workDir)) {
    const initialised = isInitialisedDataRepo(cfg.dataDir);
    if (!(options.yes && initialised)) {
      const origin = cfg.valueOrigins.DATA_DIR ?? "CLI --data";
      const hint = initialised
        ? `Pass --yes (\`bun run workspace --fresh --yes\`) to reset it, delete it manually, or unset DATA_DIR in ${origin} to use ${cfg.workDir}.`
        : "Delete it manually if intended.";
      throw new Error(
        `Refusing to delete DATA_DIR outside WORK_DIR (${cfg.workDir}): ${cfg.dataDir} (set by ${origin}). ${hint}`,
      );
    }
  }
  const previousOrigin = existsSync(join(cfg.dataDir, ".git"))
    ? runGit(["remote", "get-url", "origin"], cfg.dataDir).stdout.trim()
    : "";
  info(`data: removing ${cfg.dataDir}`, log);
  rmSync(cfg.dataDir, { recursive: true, force: true });
  const res = ensureData(cfg, log);
  if (previousOrigin && runGit(["remote", "get-url", "origin"], res.dataDir).exitCode !== 0) {
    runGitOrThrow(["remote", "add", "origin", previousOrigin], res.dataDir);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export interface PublishOptions {
  /** Explicit confirmation (`--yes`). Required to push outside CI. */
  yes?: boolean;
  log?: Logger;
}

export interface PublishResult {
  pushed: boolean;
  reason: string;
  pending: string[];
}

function currentBranch(dir: string): string {
  const name = runGit(["symbolic-ref", "--short", "HEAD"], dir).stdout.trim();
  return name || "main";
}

/**
 * Pushes committed data-repo work to `origin`.
 *
 * Pushes only when `PUBLISH=true` and either running in CI or `--yes` is given;
 * otherwise prints what would be pushed. On a rejected push it rebases once onto
 * the remote (e.g. a reviewer edited a TOML meanwhile) and retries.
 */
export function publishData(cfg: AppConfig, options: PublishOptions = {}): PublishResult {
  const log = options.log ?? defaultLog;
  const dir = cfg.dataDir;
  if (!existsSync(join(dir, ".git"))) {
    return { pushed: false, reason: `not a git repository: ${dir}`, pending: [] };
  }
  const origin = runGit(["remote", "get-url", "origin"], dir);
  if (origin.exitCode !== 0) {
    info("publish: data repo has no `origin` remote (template workspace) — nothing to publish", log);
    return { pushed: false, reason: "no origin remote", pending: [] };
  }

  const branch = currentBranch(dir);
  runGit(["fetch", "--quiet", "origin", branch], dir);
  const range = runGit(["rev-parse", "--verify", `origin/${branch}`], dir).exitCode === 0
    ? `origin/${branch}..HEAD`
    : "HEAD";
  const pending = runGit(["log", "--oneline", range], dir).stdout.split("\n").filter(Boolean);

  if (pending.length === 0) {
    info("publish: nothing to push", log);
    return { pushed: false, reason: "up to date", pending };
  }

  const allowed = cfg.publish && (isCiEnv() || options.yes === true);
  if (!allowed) {
    const why = !cfg.publish
      ? "PUBLISH is false"
      : "outside CI, pass --yes to confirm";
    info(`publish: dry run (${why}). ${pending.length} commit(s) would be pushed to ${origin.stdout.trim()} ${branch}:`, log);
    for (const line of pending.slice(0, 20)) info(`  ${line}`, log);
    if (pending.length > 20) info(`  ... and ${pending.length - 20} more`, log);
    return { pushed: false, reason: why, pending };
  }

  info(`publish: pushing ${pending.length} commit(s) to origin/${branch}`, log);
  const first = runGit(["push", "--quiet", "origin", `HEAD:${branch}`], dir);
  if (first.exitCode !== 0) {
    warn("publish: push rejected, rebasing onto origin and retrying once", log);
    const pull = runGit(["pull", "--quiet", "--rebase", "origin", branch], dir);
    if (pull.exitCode !== 0) {
      // Never leave the workspace mid-rebase: the next sync would build on top of it.
      runGit(["rebase", "--abort"], dir);
      throw new Error(`publish: rebase onto origin/${branch} failed (resolve manually): ${pull.stderr.trim()}`);
    }
    runGitOrThrow(["push", "--quiet", "origin", `HEAD:${branch}`], dir);
  }
  return { pushed: true, reason: "pushed", pending };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function workspaceStatus(cfg: AppConfig): Record<string, unknown> {
  const dataIndex = join(cfg.dataDir, "manifests", "index.json");
  let syncedCommits: number | null = null;
  if (existsSync(dataIndex)) {
    try {
      syncedCommits = ManifestIndexSchema.parse(JSON.parse(readFileSync(dataIndex, "utf8"))).commits.length;
    } catch {
      syncedCommits = null;
    }
  }
  const upstreamReady =
    cfg.upstreamKind === "fixture"
      ? isFixtureCurrent(cfg.upstreamFixtureDir)
      : cfg.upstreamKind === "remote"
        ? cfg.upstreamCache
          ? existsSync(join(cfg.upstreamMirrorDir, "HEAD"))
          : true
        : existsSync(cfg.upstreamRepo);
  return {
    upstreamReady,
    dataReady: isInitialisedDataRepo(cfg.dataDir),
    dataInsideWorkDir: isInside(cfg.dataDir, cfg.workDir),
    syncedCommits,
    siteBuilt: existsSync(join(cfg.siteOutDir, "index.json")),
  };
}
