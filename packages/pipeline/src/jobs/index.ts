import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSiteData, type BuildSiteResult } from "../build-site/index.ts";
import { INITIAL_ENV, isCiEnv, type AppConfig } from "../config.ts";
import { CONFIG_ENV_KEYS } from "../env-keys.ts";
import { defaultLog, error, info, step, success, type Logger } from "../log.ts";
import { runGit } from "../git.ts";
import { runSync, type RunSyncResult } from "../sync/index.ts";
import { validateDataRepo, type ValidateDataResult } from "../validate/index.ts";
import { ensureData, ensureUpstream, publishData, resetData, type PublishResult } from "../workspace/index.ts";

/** Writes `key=value` to `$GITHUB_OUTPUT` when present (no-op locally). */
export function emitOutput(key: string, value: string): void {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`, "utf8");
  }
}

/** Appends Markdown to `$GITHUB_STEP_SUMMARY` when present (no-op locally). */
export function appendStepSummary(markdown: string): void {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown.trimEnd()}\n`, "utf8");
  }
}

/**
 * Environment for child processes: the *original* shell environment plus explicit
 * overrides (`undefined` removes a key). Children resolve config themselves, so
 * values this process loaded from `.env` files never leak into them implicitly.
 */
export function childEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const merged: Record<string, string | undefined> = { ...INITIAL_ENV, ...overrides };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function spawnInherit(cmd: string[], cwd: string, env: Record<string, string | undefined> = {}): number {
  const proc = Bun.spawnSync(cmd, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: childEnv(env),
  });
  return proc.exitCode ?? 1;
}

/** Resolved settings the viewer (Vite) child process needs, passed explicitly. */
export function viewerEnv(cfg: AppConfig): Record<string, string> {
  return {
    WORK_DIR: cfg.workDir,
    VIEWER_BASE_PATH: cfg.viewerBasePath,
    VITE_DATA_URL: cfg.viteDataUrl,
    VIEWER_PORT: String(cfg.viewerPort),
  };
}

export interface WorkspaceJobOptions {
  fresh?: boolean;
  yes?: boolean;
  requireLocal?: boolean;
  log?: Logger;
}

/** `workspace`: ensure the upstream (fixture | mirror fetch | path) and the data repo. */
export async function runWorkspace(
  cfg: AppConfig,
  options: WorkspaceJobOptions | Logger = defaultLog,
): Promise<{ upstream: string }> {
  const opts: WorkspaceJobOptions = typeof options === "function" ? { log: options } : options;
  const log = opts.log ?? defaultLog;
  const upstream = ensureUpstream(cfg, { log, requireLocal: opts.requireLocal });
  if (opts.fresh) {
    resetData(cfg, log, { yes: opts.yes });
  } else {
    ensureData(cfg, log);
  }
  return { upstream };
}

export async function runSyncStep(
  cfg: AppConfig,
  upstream: string,
  log?: Logger,
): Promise<RunSyncResult> {
  return runSync({
    upstreamUrlOrPath: upstream,
    dataDir: cfg.dataDir,
    maxMinutes: cfg.syncMaxMinutes,
    maxBatches: cfg.syncMaxBatches,
    baselineDate: cfg.baselineDate,
    provider: cfg.aiProvider,
    model: cfg.aiModel,
    baseUrl: cfg.aiBaseUrl,
    reasoningEffort: cfg.aiReasoningEffort,
    llmConcurrency: cfg.aiConcurrency,
    maxInputTokens: cfg.aiMaxInputTokens,
    maxOutputTokens: cfg.aiMaxOutputTokens,
    commitChanges: cfg.syncCommit,
    failFast: cfg.syncFailFast,
    jobs: cfg.jobs,
    ...(log ? { log } : {}),
  });
}

export async function runValidateStep(cfg: AppConfig, log: Logger = defaultLog): Promise<ValidateDataResult> {
  const result = await validateDataRepo(cfg.dataDir, { jobs: cfg.jobs });
  if (!result.ok) {
    for (const err of result.errors) error(err, log);
  } else {
    info(
      `validate: ${result.unitCount} units, ${result.chapterCount} chapters, ${result.snapshotCount} snapshots OK`,
      log,
    );
  }
  return result;
}

export async function runBuildSiteStep(
  cfg: AppConfig,
  outDir = cfg.siteOutDir,
  renderCache?: Map<string, string>,
): Promise<BuildSiteResult> {
  for (const sub of [
    "assets",
    "trees",
    "chapters",
    "packs",
    "meta",
    "index.json",
    "anchors.json",
    "search.json",
  ]) {
    rmSync(join(outDir, sub), { recursive: true, force: true });
  }
  const upstreamDir =
    cfg.upstreamKind === "remote"
      ? existsSync(cfg.upstreamMirrorDir)
        ? cfg.upstreamMirrorDir
        : undefined
      : existsSync(cfg.upstreamRepo)
        ? cfg.upstreamRepo
        : undefined;
  return buildSiteData({
    dataDir: cfg.dataDir,
    outDir,
    dataRepoUrl: cfg.dataRepoUrl || undefined,
    upstreamRepoUrl: cfg.upstreamRepoUrl || undefined,
    upstreamDir,
    renderCache,
    jobs: cfg.jobs,
  });
}

/**
 * Produces the exact static artifact GitHub Pages serves: Vite build into DIST_DIR,
 * then site data into DIST_DIR/data (replacing dev data Vite copied from public/data).
 */
export async function runBuild(cfg: AppConfig, log: Logger = defaultLog): Promise<BuildSiteResult> {
  step(`build viewer → ${cfg.distDir}`, log);
  const viewerDir = join(cfg.repoRoot, "packages", "viewer");
  const code = spawnInherit(
    ["bun", "run", "build", "--outDir", cfg.distDir, "--emptyOutDir", "--logLevel", "warn"],
    viewerDir,
    viewerEnv(cfg),
  );
  if (code !== 0) throw new Error(`viewer build failed (exit ${code})`);

  step(`build site data → ${join(cfg.distDir, "data")}`, log);
  const result = await runBuildSiteStep(cfg, join(cfg.distDir, "data"));
  info(
    `build: ${result.chapters} chapters, ${result.packs} packs, ${result.units} units, ${result.snapshots} snapshots`,
    log,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Jobs: exactly what the GitHub workflows run.
// ---------------------------------------------------------------------------

export interface SyncJobResult {
  sync: RunSyncResult | null;
  validation: ValidateDataResult | null;
  publish: PublishResult | null;
}

/**
 * job:sync = workspace → sync → validate → (finally) publish:data.
 *
 * Committed checkpoints are published even if sync throws midway (e.g. an LLM API
 * error), so progress is never lost. Nothing is published if validation fails.
 */
export async function runSyncJob(
  cfg: AppConfig,
  opts: { yes?: boolean; log?: Logger } = {},
): Promise<SyncJobResult> {
  const log = opts.log ?? defaultLog;
  step("workspace", log);
  const { upstream } = await runWorkspace(cfg, log);

  const dataHead = () =>
    existsSync(join(cfg.dataDir, ".git"))
      ? runGit(["rev-parse", "--verify", "HEAD"], cfg.dataDir).stdout.trim()
      : "";
  const headBeforeSync = dataHead();

  let syncResult: RunSyncResult | null = null;
  let validation: ValidateDataResult | null = null;
  let failure: unknown = null;

  try {
    const effectiveCfg: AppConfig =
      cfg.syncMaxMinutes === undefined && isCiEnv() ? { ...cfg, syncMaxMinutes: 45 } : cfg;
    step(`sync ← ${upstream} (provider: ${effectiveCfg.aiProvider})`, log);
    syncResult = await runSyncStep(effectiveCfg, upstream, log);
    info(`sync: ${JSON.stringify(syncResult)}`, log);
  } catch (err) {
    failure = err;
  }

  try {
    step("validate", log);
    validation = await runValidateStep(cfg, log);
    if (!validation.ok && !failure) failure = new Error("data validation failed");
  } catch (err) {
    if (failure) error(`validate failed too: ${err instanceof Error ? err.message : String(err)}`, log);
    else failure = err;
  }

  const headAfterSync = dataHead();
  const committedDuringSync = Boolean(headAfterSync && headAfterSync !== headBeforeSync);
  const madeProgress =
    committedDuringSync ||
    (syncResult?.processedCommits ?? 0) > 0 ||
    (syncResult?.translatedUnits ?? 0) > 0;
  // Emit before publishing so the workflow sees them even if the push fails.
  emitOutput("has_remaining", syncResult?.hasRemaining ? "true" : "false");
  emitOutput("made_progress", madeProgress ? "true" : "false");

  let publish: PublishResult | null = null;
  if (!validation?.ok) {
    info("publish: skipped because validation failed", log);
  } else {
    step("publish:data", log);
    try {
      publish = publishData(cfg, { yes: opts.yes, log });
    } catch (err) {
      if (failure) error(`publish failed too: ${err instanceof Error ? err.message : String(err)}`, log);
      else failure = err;
    }
  }

  emitOutput("pushed", publish?.pushed ? "true" : "false");
  appendStepSummary(
    [
      "### Sync Summary",
      "",
      "| Metric | Value |",
      "|---|---|",
      `| Processed commits | ${syncResult ? syncResult.processedCommits : committedDuringSync ? "partial (checkpointed)" : 0} |`,
      `| Translated units | ${syncResult ? syncResult.translatedUnits : committedDuringSync ? "partial (checkpointed)" : 0} |`,
      `| Validation | ${validation?.ok ? "passed" : "failed"} |`,
      `| Published | ${publish?.pushed ? `pushed (${publish.pending.length} commit(s))` : publish?.reason ?? "skipped"} |`,
      `| Remaining work | ${syncResult?.hasRemaining ? "yes" : "no"} |`,
    ].join("\n"),
  );

  if (failure) throw failure;
  return { sync: syncResult, validation, publish };
}

/** job:deploy = workspace → validate → build. Output: DIST_DIR. */
export async function runDeployJob(cfg: AppConfig, log: Logger = defaultLog): Promise<BuildSiteResult> {
  step("workspace", log);
  await runWorkspace(cfg, { log, requireLocal: true });
  step("validate", log);
  const validation = await runValidateStep(cfg, log);
  if (!validation.ok) throw new Error("data validation failed");
  const result = await runBuild(cfg, log);
  appendStepSummary(
    [
      "### Deploy Build Summary",
      "",
      "| Metric | Value |",
      "|---|---|",
      `| Chapters | ${result.chapters} |`,
      `| Packs | ${result.packs} |`,
      `| Units | ${result.units} |`,
      `| Snapshots | ${result.snapshots} |`,
    ].join("\n"),
  );
  return result;
}

export interface CheckOptions {
  typecheck?: boolean;
  test?: boolean;
  e2e?: boolean;
  log?: Logger;
}

/**
 * check = typecheck → unit tests → end-to-end rehearsal of the remote flows
 * (job:sync twice + job:deploy) against the fixture in a throwaway WORK_DIR.
 * `job:ci` is exactly this.
 */
export async function runCheck(cfg: AppConfig, opts: CheckOptions = {}): Promise<void> {
  const log = opts.log ?? defaultLog;
  const root = cfg.repoRoot;

  if (opts.typecheck !== false) {
    step("typecheck", log);
    if (spawnInherit(["bun", "run", "typecheck"], root) !== 0) throw new Error("typecheck failed");
  }

  if (opts.test !== false) {
    step("unit tests", log);
    if (spawnInherit(["bun", "test"], root) !== 0) throw new Error("tests failed");
  }

  if (opts.e2e !== false) {
    await runE2E(root, log);
  }
  success("check passed", log);
}

async function runE2E(root: string, log: Logger): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "riscv-cn-e2e-"));
  const cli = join(root, "packages", "pipeline", "src", "cli.ts");
  // Hermetic: drop every config key from the caller's environment, ignore personal
  // .env files, and force the offline, zero-cost fixture + mock settings.
  const env: Record<string, string | undefined> = {
    ...Object.fromEntries(CONFIG_ENV_KEYS.map((k) => [k, undefined])),
    GITHUB_OUTPUT: undefined,
    GITHUB_STEP_SUMMARY: undefined,
    RISCV_CN_NO_DOTENV: "1",
    UPSTREAM_REPO: "fixture",
    DATA_REMOTE: "template",
    AI_PROVIDER: "mock",
    PUBLISH: "false",
    WORK_DIR: join(tmp, "work"),
    DIST_DIR: join(tmp, "dist"),
    SITE_OUT_DIR: join(tmp, "site"),
  };
  try {
    step("e2e: job:sync (fixture, mock)", log);
    if (spawnInherit(["bun", cli, "job", "sync", "--fail-fast"], root, env) !== 0) {
      throw new Error("e2e job:sync failed");
    }

    step("e2e: job:sync again (must be an idempotent no-op)", log);
    if (spawnInherit(["bun", cli, "job", "sync", "--fail-fast"], root, env) !== 0) {
      throw new Error("e2e job:sync (rerun) failed");
    }

    step("e2e: job:deploy", log);
    if (spawnInherit(["bun", cli, "job", "deploy"], root, env) !== 0) throw new Error("e2e job:deploy failed");

    for (const required of ["index.html", "data/index.json", "data/anchors.json", "data/search.json"]) {
      if (!existsSync(join(tmp, "dist", required))) {
        throw new Error(`e2e: expected artifact missing: dist/${required}`);
      }
    }
    const builtHtml = readFileSync(join(tmp, "dist", "index.html"), "utf8");
    const scriptTags = [...builtHtml.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    if (scriptTags.length === 0 || scriptTags.some((tag) => !/^<script\s+data-cfasync="false"/i.test(tag))) {
      throw new Error(`e2e: dist/index.html has <script> without leading data-cfasync="false"`);
    }
    info("e2e: Pages artifact complete", log);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
