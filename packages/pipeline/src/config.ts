import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_AI_CONCURRENCY,
  DEFAULT_AI_MAX_INPUT_TOKENS,
  DEFAULT_AI_MAX_OUTPUT_TOKENS,
  REASONING_EFFORT_VALUES,
  type ReasoningEffort,
} from "./env-keys.ts";
import { defaultJobs } from "./parallel/index.ts";

/**
 * Monorepo root. Uses `import.meta.url` (not Bun's `import.meta.dir`) so this module
 * also works when imported from `vite.config.ts` running under Node.
 */
export const MONOREPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

/** Special `UPSTREAM_REPO` value: generate a tiny offline upstream under WORK_DIR. */
export const UPSTREAM_FIXTURE = "fixture";

/** Special `DATA_REMOTE` value: initialise the data repo from `templates/data-repo`. */
export const DATA_REMOTE_TEMPLATE = "template";

export interface CliConfigOverrides {
  envFile?: string;
  upstream?: string;
  data?: string;
  out?: string;
  dataRepoUrl?: string;
  upstreamRepoUrl?: string;
  baselineDate?: string;
  maxMinutes?: number;
  maxBatches?: number;
  provider?: string;
  model?: string;
  baseUrl?: string;
  reasoningEffort?: string;
  llmConcurrency?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  commitChanges?: boolean;
  failFast?: boolean;
  jobs?: number;
}

export interface LoadDotEnvOptions {
  envFile?: string;
  callerCwd?: string;
  repoRoot?: string;
  env?: Record<string, string | undefined>;
  applyToProcessEnv?: boolean;
  /** Skip `.env` / `.env.local` discovery (also enabled by `RISCV_CN_NO_DOTENV=1`). */
  ignoreDotEnvFiles?: boolean;
}

export interface LoadedDotEnvResult {
  mergedEnv: Record<string, string | undefined>;
  loadedEnvFiles: string[];
  /** Directory against which a relative path value for this key is resolved. */
  valueSources: Record<string, string>;
  /** Human-readable origin of each value (file path, `DOTENV`, `shell`). */
  valueOrigins: Record<string, string>;
  callerCwd: string;
  repoRoot: string;
}

export type UpstreamKind = "fixture" | "remote" | "local";

export interface AppConfig {
  repoRoot: string;
  workDir: string;
  /** Configured upstream: remote URL, absolute local path, or the fixture directory. */
  upstreamRepo: string;
  upstreamKind: UpstreamKind;
  /** Use a bare mirror under WORK_DIR for remote upstreams (fetch instead of re-clone). */
  upstreamCache: boolean;
  upstreamMirrorDir: string;
  upstreamFixtureDir: string;
  dataDir: string;
  /** Where `workspace` gets the data repo from: git URL, local path, or `template`. */
  dataRemote: string;
  siteOutDir: string;
  distDir: string;
  dataRepoUrl: string;
  upstreamRepoUrl: string;
  dataRepo: string;
  aiProvider: string;
  aiModel: string | undefined;
  aiBaseUrl: string | undefined;
  aiReasoningEffort: ReasoningEffort | undefined;
  aiConcurrency: number;
  aiMaxInputTokens: number;
  aiMaxOutputTokens: number;
  baselineDate: string | undefined;
  syncMaxMinutes: number | undefined;
  syncMaxBatches: number | undefined;
  syncCommit: boolean;
  syncFailFast: boolean;
  jobs: number;
  publish: boolean;
  viewerBasePath: string;
  viewerPort: number;
  viteDataUrl: string;
  loadedEnvFiles: string[];
  valueOrigins: Record<string, string>;
}

export const API_KEY_ENV_NAMES = [
  "DEEPSEEK_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "LANGSMITH_API_KEY",
] as const;

/**
 * The process environment as it was before any config was applied to it. Child
 * processes start from this (plus explicit overrides) and resolve config themselves,
 * so values loaded from personal `.env` files never leak into hermetic children.
 */
export const INITIAL_ENV: Readonly<Record<string, string | undefined>> = Object.freeze({ ...process.env });

/** File touched after each `bun run dev` site rebuild; the Vite dev server reloads on change. */
export function siteBuildStampPath(cfg: Pick<AppConfig, "workDir">): string {
  return resolve(cfg.workDir, "site-build-stamp");
}

/** Directory the user invoked the command from (`bun run` sets INIT_CWD). */
export function getCallerCwd(): string {
  return process.env.INIT_CWD || process.cwd();
}

export function isTruthyEnv(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** True when running inside CI (GitHub Actions sets both `CI` and `GITHUB_ACTIONS`). */
export function isCiEnv(env: Record<string, string | undefined> = process.env): boolean {
  return isTruthyEnv(env.CI) || isTruthyEnv(env.GITHUB_ACTIONS);
}

export function isRemoteGitOrHttpUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) || value.startsWith("git@");
}

function unescapeDoubleQuoted(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      switch (next) {
        case "n":
          out += "\n";
          i++;
          continue;
        case "r":
          out += "\r";
          i++;
          continue;
        case "t":
          out += "\t";
          i++;
          continue;
        case "\\":
          out += "\\";
          i++;
          continue;
        case '"':
          out += '"';
          i++;
          continue;
      }
    }
    out += ch;
  }
  return out;
}

function parseDotEnvValue(rawValue: string): string {
  const trimmedStart = rawValue.trimStart();
  if (trimmedStart.startsWith('"')) {
    let endIdx = -1;
    let escaped = false;
    for (let i = 1; i < trimmedStart.length; i++) {
      const ch = trimmedStart[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        endIdx = i;
        break;
      }
    }
    const inner = endIdx >= 0 ? trimmedStart.slice(1, endIdx) : trimmedStart.slice(1);
    return unescapeDoubleQuoted(inner);
  }

  if (trimmedStart.startsWith("'")) {
    const endIdx = trimmedStart.indexOf("'", 1);
    return endIdx >= 0 ? trimmedStart.slice(1, endIdx) : trimmedStart.slice(1);
  }

  // Unquoted value: strip inline comment (` #...`) and trim outer whitespace
  const inlineCommentMatch = trimmedStart.match(/\s+#/);
  const clean =
    inlineCommentMatch && inlineCommentMatch.index !== undefined
      ? trimmedStart.slice(0, inlineCommentMatch.index)
      : trimmedStart;
  return clean.trim();
}

/**
 * Parses a `.env` file payload cleanly without spawning subshells.
 * Supports blank lines, `#` comments, `export KEY=...`, single quotes,
 * double quotes with escapes, and inline comments on unquoted values.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const normalized = content.replace(/^\uFEFF/, "");
  const out: Record<string, string> = {};
  for (const rawLine of normalized.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (!line || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") || line.startsWith("export\t")
      ? line.slice(6).trimStart()
      : line;

    const eqIdx = withoutExport.indexOf("=");
    if (eqIdx <= 0) continue;

    const key = withoutExport.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    const rawValue = withoutExport.slice(eqIdx + 1);
    out[key] = parseDotEnvValue(rawValue);
  }
  return out;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Loads configuration layers. Lowest to highest precedence:
 *
 *   1. `.env`                     gitignored, personal config
 *   2. `.env.local`               gitignored, secrets + personal overrides
 *   3. `DOTENV`                   multi-line `.env` blob in the environment (CI secret)
 *   4. shell environment          (GitHub `secrets.*` / `vars.*` land here in CI)
 *   5. `--env-file` / `ENV_FILE`  explicit file
 *   (6. CLI flags, applied by `resolveAppConfig`)
 *
 * Empty values (`KEY=`) mean "unset" in every layer, so a blank GitHub variable or a
 * placeholder line in `.env.local` never clobbers a value from a lower layer.
 */
export function loadDotEnvFiles(options: LoadDotEnvOptions = {}): LoadedDotEnvResult {
  const callerCwd = resolve(options.callerCwd ?? getCallerCwd());
  const repoRoot = resolve(options.repoRoot ?? MONOREPO_ROOT);
  const targetEnv = options.env ?? process.env;
  const applyToProcessEnv = options.applyToProcessEnv ?? true;
  const ignoreDotEnvFiles =
    options.ignoreDotEnvFiles ?? isTruthyEnv(targetEnv.RISCV_CN_NO_DOTENV);

  const loadedEnvFiles: string[] = [];
  const mergedEnv: Record<string, string | undefined> = {};
  const valueSources: Record<string, string> = {};
  const valueOrigins: Record<string, string> = {};

  const applyLayer = (values: Record<string, string | undefined>, baseDir: string, origin: string) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined || v.trim() === "") continue;
      mergedEnv[k] = v;
      valueSources[k] = baseDir;
      valueOrigins[k] = origin;
    }
  };

  // 1-2. .env, .env.local
  const autoCandidates: string[] = ignoreDotEnvFiles
    ? []
    : [resolve(repoRoot, ".env"), resolve(repoRoot, ".env.local")];
  for (const filePath of autoCandidates) {
    if (!existsSync(filePath)) continue;
    loadedEnvFiles.push(filePath);
    applyLayer(parseDotEnv(readFileSync(filePath, "utf8")), dirname(filePath), filePath);
  }

  // 3. DOTENV blob
  const dotenvBlob = nonEmpty(targetEnv.DOTENV) ? parseDotEnv(targetEnv.DOTENV!) : {};
  applyLayer(dotenvBlob, repoRoot, "DOTENV");

  // 4. Shell environment (excluding the DOTENV blob itself)
  const shellValues: Record<string, string | undefined> = { ...targetEnv };
  delete shellValues.DOTENV;
  applyLayer(shellValues, callerCwd, "shell");

  // 5. Explicit --env-file (or ENV_FILE)
  const explicitRaw = options.envFile?.trim() || targetEnv.ENV_FILE?.trim();
  if (explicitRaw) {
    const explicitPath = isAbsolute(explicitRaw) ? explicitRaw : resolve(callerCwd, explicitRaw);
    if (!existsSync(explicitPath)) {
      throw new Error(`Env file not found: ${explicitPath}`);
    }
    loadedEnvFiles.push(explicitPath);
    applyLayer(parseDotEnv(readFileSync(explicitPath, "utf8")), dirname(explicitPath), explicitPath);
  }

  if (applyToProcessEnv) {
    for (const [k, v] of Object.entries(mergedEnv)) {
      if (v !== undefined) {
        targetEnv[k] = v;
      }
    }
  }

  return {
    mergedEnv,
    loadedEnvFiles,
    valueSources,
    valueOrigins,
    callerCwd,
    repoRoot,
  };
}

function parseOptionalPositiveNumber(raw: string | undefined, name: string): number | undefined {
  const val = nonEmpty(raw);
  if (!val) return undefined;
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`Invalid ${name} value: "${raw}". Expected a positive number.`);
  }
  return num;
}

function parseOptionalPositiveInt(raw: string | undefined, name: string): number | undefined {
  const val = nonEmpty(raw);
  if (!val) return undefined;
  const num = Number(val);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`Invalid ${name} value: "${raw}". Expected a positive integer.`);
  }
  return num;
}

function parseOptionalBoolean(raw: string | undefined, defaultValue: boolean, name: string): boolean {
  const val = nonEmpty(raw)?.toLowerCase();
  if (!val) return defaultValue;
  if (val === "true" || val === "1" || val === "yes") return true;
  if (val === "false" || val === "0" || val === "no") return false;
  throw new Error(`Invalid ${name} value: "${raw}". Expected true or false.`);
}

export function parseOptionalReasoningEffort(
  raw: string | undefined,
  name = "AI_REASONING_EFFORT",
): ReasoningEffort | undefined {
  const val = nonEmpty(raw)?.toLowerCase();
  if (!val) return undefined;
  if ((REASONING_EFFORT_VALUES as readonly string[]).includes(val)) {
    return val as ReasoningEffort;
  }
  throw new Error(
    `Invalid ${name} value: "${raw}". Expected one of: ${REASONING_EFFORT_VALUES.join(", ")}.`,
  );
}

function resolvePathValue(
  cliValue: string | undefined,
  envKey: string,
  loaded: LoadedDotEnvResult,
  allowRemoteUrl = false,
): string | undefined {
  const cliClean = nonEmpty(cliValue);
  if (cliClean) {
    if (allowRemoteUrl && isRemoteGitOrHttpUrl(cliClean)) return cliClean;
    return isAbsolute(cliClean) ? cliClean : resolve(loaded.callerCwd, cliClean);
  }

  const envClean = nonEmpty(loaded.mergedEnv[envKey]);
  if (envClean) {
    if (allowRemoteUrl && isRemoteGitOrHttpUrl(envClean)) return envClean;
    const baseDir = loaded.valueSources[envKey] ?? loaded.repoRoot;
    return isAbsolute(envClean) ? envClean : resolve(baseDir, envClean);
  }
  return undefined;
}

function resolvePathSetting(
  cliValue: string | undefined,
  envKey: string,
  defaultValue: string,
  loaded: LoadedDotEnvResult,
  allowRemoteUrl = false,
): string {
  const resolved = resolvePathValue(cliValue, envKey, loaded, allowRemoteUrl);
  if (resolved) return resolved;
  if (allowRemoteUrl && isRemoteGitOrHttpUrl(defaultValue)) return defaultValue;
  return isAbsolute(defaultValue) ? defaultValue : resolve(loaded.repoRoot, defaultValue);
}

/**
 * Resolves unified configuration across `.env` files, `DOTENV`, shell
 * environment, CLI overrides, and built-in defaults.
 */
export function resolveAppConfig(
  cliOverrides: CliConfigOverrides = {},
  options: LoadDotEnvOptions = {},
): AppConfig {
  const loaded = loadDotEnvFiles({
    ...options,
    envFile: cliOverrides.envFile ?? options.envFile,
  });
  const env = loaded.mergedEnv;

  const workDir = resolvePathSetting(undefined, "WORK_DIR", "./.work", loaded);
  const upstreamFixtureDir = resolve(workDir, "upstream-fixture");
  const upstreamMirrorDir = resolve(workDir, "upstream.git");

  const rawUpstream = nonEmpty(cliOverrides.upstream) ?? nonEmpty(env.UPSTREAM_REPO);
  let upstreamRepo: string;
  let upstreamKind: UpstreamKind;
  if (rawUpstream?.toLowerCase() === UPSTREAM_FIXTURE) {
    upstreamRepo = upstreamFixtureDir;
    upstreamKind = "fixture";
  } else {
    upstreamRepo = resolvePathSetting(
      cliOverrides.upstream,
      "UPSTREAM_REPO",
      "https://github.com/riscv/riscv-isa-manual.git",
      loaded,
      true,
    );
    upstreamKind = isRemoteGitOrHttpUrl(upstreamRepo) ? "remote" : "local";
  }
  const upstreamCache = parseOptionalBoolean(env.UPSTREAM_CACHE, true, "UPSTREAM_CACHE");

  const dataDir =
    resolvePathValue(cliOverrides.data, "DATA_DIR", loaded) ?? resolve(workDir, "data");
  const siteOutDir = resolvePathSetting(
    cliOverrides.out,
    "SITE_OUT_DIR",
    "./packages/viewer/public/data",
    loaded,
  );
  const distDir = resolvePathSetting(undefined, "DIST_DIR", "./packages/viewer/dist", loaded);

  // Data repository identity: explicit DATA_REPO, else derived from the GitHub owner in CI.
  const ghOwner = nonEmpty(env.GITHUB_REPOSITORY_OWNER);
  const dataRepo =
    nonEmpty(env.DATA_REPO) ?? (ghOwner ? `${ghOwner}/riscv-isa-manual-cn-data` : "");

  const rawDataRemote = nonEmpty(env.DATA_REMOTE);
  let dataRemote: string;
  if (rawDataRemote?.toLowerCase() === DATA_REMOTE_TEMPLATE) {
    dataRemote = DATA_REMOTE_TEMPLATE;
  } else if (rawDataRemote) {
    dataRemote = resolvePathValue(undefined, "DATA_REMOTE", loaded, true)!;
  } else {
    dataRemote = dataRepo ? `https://github.com/${dataRepo}.git` : DATA_REMOTE_TEMPLATE;
  }

  const aiProvider = (
    nonEmpty(cliOverrides.provider) ??
    nonEmpty(env.AI_PROVIDER) ??
    "openai"
  ).toLowerCase();

  const PROVIDER_BASE_URL_ENV: Record<string, string> = {
    deepseek: "DEEPSEEK_BASE_URL",
    google: "GOOGLE_GENERATIVE_AI_BASE_URL",
    openai: "OPENAI_BASE_URL",
    anthropic: "ANTHROPIC_BASE_URL",
  };
  const providerBaseUrlKey = PROVIDER_BASE_URL_ENV[aiProvider];
  const aiModel = nonEmpty(cliOverrides.model) ?? nonEmpty(env.AI_MODEL);
  const aiBaseUrl =
    nonEmpty(cliOverrides.baseUrl) ??
    (providerBaseUrlKey ? nonEmpty(env[providerBaseUrlKey]) : undefined) ??
    nonEmpty(env.AI_BASE_URL);

  let aiReasoningEffort: ReasoningEffort | undefined;
  if (cliOverrides.reasoningEffort !== undefined) {
    if (!nonEmpty(cliOverrides.reasoningEffort)) {
      throw new Error(
        `Invalid --reasoning-effort value: "${cliOverrides.reasoningEffort}". Expected one of: ${REASONING_EFFORT_VALUES.join(", ")}.`,
      );
    }
    aiReasoningEffort = parseOptionalReasoningEffort(cliOverrides.reasoningEffort, "--reasoning-effort");
  } else {
    aiReasoningEffort = parseOptionalReasoningEffort(env.AI_REASONING_EFFORT, "AI_REASONING_EFFORT");
  }

  if (
    cliOverrides.llmConcurrency !== undefined &&
    (!Number.isInteger(cliOverrides.llmConcurrency) || cliOverrides.llmConcurrency <= 0)
  ) {
    throw new Error(`Invalid --llm-concurrency value: ${cliOverrides.llmConcurrency}`);
  }
  const aiConcurrency =
    cliOverrides.llmConcurrency ??
    parseOptionalPositiveInt(env.AI_CONCURRENCY, "AI_CONCURRENCY") ??
    DEFAULT_AI_CONCURRENCY;

  if (
    cliOverrides.maxInputTokens !== undefined &&
    (!Number.isInteger(cliOverrides.maxInputTokens) || cliOverrides.maxInputTokens <= 0)
  ) {
    throw new Error(`Invalid --max-input-tokens value: ${cliOverrides.maxInputTokens}`);
  }
  const aiMaxInputTokens =
    cliOverrides.maxInputTokens ??
    parseOptionalPositiveInt(env.AI_MAX_INPUT_TOKENS, "AI_MAX_INPUT_TOKENS") ??
    DEFAULT_AI_MAX_INPUT_TOKENS;

  if (
    cliOverrides.maxOutputTokens !== undefined &&
    (!Number.isInteger(cliOverrides.maxOutputTokens) || cliOverrides.maxOutputTokens <= 0)
  ) {
    throw new Error(`Invalid --max-output-tokens value: ${cliOverrides.maxOutputTokens}`);
  }
  const aiMaxOutputTokens =
    cliOverrides.maxOutputTokens ??
    parseOptionalPositiveInt(env.AI_MAX_OUTPUT_TOKENS, "AI_MAX_OUTPUT_TOKENS") ??
    DEFAULT_AI_MAX_OUTPUT_TOKENS;

  const baselineDate = nonEmpty(cliOverrides.baselineDate) ?? nonEmpty(env.BASELINE_DATE);

  if (cliOverrides.maxMinutes !== undefined && (!Number.isFinite(cliOverrides.maxMinutes) || cliOverrides.maxMinutes <= 0)) {
    throw new Error(`Invalid --max-minutes value: ${cliOverrides.maxMinutes}`);
  }
  const syncMaxMinutes =
    cliOverrides.maxMinutes ?? parseOptionalPositiveNumber(env.SYNC_MAX_MINUTES, "SYNC_MAX_MINUTES");

  if (cliOverrides.maxBatches !== undefined && (!Number.isInteger(cliOverrides.maxBatches) || cliOverrides.maxBatches <= 0)) {
    throw new Error(`Invalid --max-batches value: ${cliOverrides.maxBatches}`);
  }
  const syncMaxBatches =
    cliOverrides.maxBatches ?? parseOptionalPositiveInt(env.SYNC_MAX_BATCHES, "SYNC_MAX_BATCHES");

  const syncCommit =
    cliOverrides.commitChanges !== undefined
      ? cliOverrides.commitChanges
      : parseOptionalBoolean(env.SYNC_COMMIT, true, "SYNC_COMMIT");

  const syncFailFast =
    cliOverrides.failFast !== undefined
      ? cliOverrides.failFast
      : parseOptionalBoolean(env.SYNC_FAIL_FAST, isCiEnv(env), "SYNC_FAIL_FAST");

  if (cliOverrides.jobs !== undefined && (!Number.isInteger(cliOverrides.jobs) || cliOverrides.jobs <= 0)) {
    throw new Error(`Invalid --jobs value: ${cliOverrides.jobs}`);
  }
  const jobs =
    cliOverrides.jobs ??
    parseOptionalPositiveInt(env.JOBS, "JOBS") ??
    defaultJobs();

  const publish = parseOptionalBoolean(env.PUBLISH, true, "PUBLISH");

  const viewerPort =
    parseOptionalPositiveInt(env.VIEWER_PORT, "VIEWER_PORT") ?? 5173;

  const defaultUpstreamRepoUrl = /^https?:\/\//.test(upstreamRepo)
    ? upstreamRepo.replace(/\/+$/, "").replace(/\.git$/, "")
    : "https://github.com/riscv/riscv-isa-manual";

  return {
    repoRoot: loaded.repoRoot,
    workDir,
    upstreamRepo,
    upstreamKind,
    upstreamCache,
    upstreamMirrorDir,
    upstreamFixtureDir,
    dataDir,
    dataRemote,
    siteOutDir,
    distDir,
    dataRepoUrl:
      nonEmpty(cliOverrides.dataRepoUrl) ??
      nonEmpty(env.DATA_REPO_URL) ??
      (dataRepo ? `https://github.com/${dataRepo}` : ""),
    upstreamRepoUrl:
      nonEmpty(cliOverrides.upstreamRepoUrl) ??
      nonEmpty(env.UPSTREAM_REPO_URL) ??
      defaultUpstreamRepoUrl,
    dataRepo,
    aiProvider,
    aiModel,
    aiBaseUrl,
    aiReasoningEffort,
    aiConcurrency,
    aiMaxInputTokens,
    aiMaxOutputTokens,
    baselineDate,
    syncMaxMinutes,
    syncMaxBatches,
    syncCommit,
    syncFailFast,
    jobs,
    publish,
    viewerBasePath: nonEmpty(env.VIEWER_BASE_PATH) ?? "./",
    viewerPort,
    viteDataUrl: nonEmpty(env.VITE_DATA_URL) ?? "./data",
    loadedEnvFiles: loaded.loadedEnvFiles,
    valueOrigins: loaded.valueOrigins,
  };
}

const DISPLAY_ORIGIN_KEYS = [
  "UPSTREAM_REPO",
  "UPSTREAM_CACHE",
  "UPSTREAM_REPO_URL",
  "DATA_DIR",
  "DATA_REMOTE",
  "DATA_REPO",
  "DATA_REPO_URL",
  "SITE_OUT_DIR",
  "DIST_DIR",
  "WORK_DIR",
  "AI_PROVIDER",
  "AI_MODEL",
  "AI_BASE_URL",
  "DEEPSEEK_BASE_URL",
  "GOOGLE_GENERATIVE_AI_BASE_URL",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "AI_REASONING_EFFORT",
  "AI_CONCURRENCY",
  "AI_MAX_INPUT_TOKENS",
  "AI_MAX_OUTPUT_TOKENS",
  "BASELINE_DATE",
  "SYNC_MAX_MINUTES",
  "SYNC_MAX_BATCHES",
  "SYNC_COMMIT",
  "SYNC_FAIL_FAST",
  "JOBS",
  "PUBLISH",
  "VIEWER_BASE_PATH",
  "VIEWER_PORT",
  "VITE_DATA_URL",
  "LANGSMITH_TRACING",
  "LANGSMITH_ENDPOINT",
  "LANGSMITH_PROJECT",
  "LANGSMITH_AGENT_ID",
  "LANGSMITH_AGENT_ENVIRONMENT",
  "LANGSMITH_WORKSPACE_ID",
  "VERBOSE",
  "DEBUG",
] as const;

/**
 * Formats resolved configuration for display without leaking API key secrets.
 */
export function formatConfigForDisplay(
  config: AppConfig,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  const apiKeys: Record<string, "(set)" | "(not set)"> = {};
  for (const keyName of API_KEY_ENV_NAMES) {
    const value =
      keyName === "LANGSMITH_API_KEY"
        ? nonEmpty(env.LANGSMITH_API_KEY) ?? nonEmpty(env.LANGCHAIN_API_KEY)
        : nonEmpty(env[keyName]);
    apiKeys[keyName] = value ? "(set)" : "(not set)";
  }

  const origins: Record<string, string> = {};
  for (const key of DISPLAY_ORIGIN_KEYS) {
    const origin = config.valueOrigins[key];
    if (origin) origins[key] = origin;
  }

  return {
    loadedEnvFiles: config.loadedEnvFiles,
    workDir: config.workDir,
    upstreamRepo: config.upstreamRepo,
    upstreamKind: config.upstreamKind,
    upstreamCache: config.upstreamKind === "remote" ? config.upstreamCache : undefined,
    dataDir: config.dataDir,
    dataRemote: config.dataRemote,
    siteOutDir: config.siteOutDir,
    distDir: config.distDir,
    dataRepoUrl: config.dataRepoUrl,
    upstreamRepoUrl: config.upstreamRepoUrl,
    dataRepo: config.dataRepo,
    aiProvider: config.aiProvider,
    aiModel: config.aiModel ?? "(provider default)",
    aiBaseUrl: config.aiBaseUrl ?? "(provider default)",
    aiReasoningEffort: config.aiReasoningEffort ?? "(provider default)",
    aiConcurrency: config.aiConcurrency,
    aiMaxInputTokens: config.aiMaxInputTokens,
    aiMaxOutputTokens: config.aiMaxOutputTokens,
    baselineDate: config.baselineDate ?? "(manifest default)",
    syncMaxMinutes: config.syncMaxMinutes ?? null,
    syncMaxBatches: config.syncMaxBatches ?? null,
    syncCommit: config.syncCommit,
    syncFailFast: config.syncFailFast,
    jobs: config.jobs,
    publish: config.publish,
    viewerBasePath: config.viewerBasePath,
    viewerPort: config.viewerPort,
    viteDataUrl: config.viteDataUrl,
    apiKeys,
    dataRepoToken: nonEmpty(env.DATA_REPO_TOKEN) ? "(set)" : "(not set)",
    origins,
  };
}

