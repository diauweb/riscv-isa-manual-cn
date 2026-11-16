import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatConfigForDisplay,
  MONOREPO_ROOT,
  parseDotEnv,
  resolveAppConfig,
} from "../src/config.ts";
import {
  DEFAULT_AI_CONCURRENCY,
  DEFAULT_AI_MAX_INPUT_TOKENS,
  DEFAULT_AI_MAX_OUTPUT_TOKENS,
} from "../src/env-keys.ts";
import { defaultJobs } from "../src/parallel/index.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("parseDotEnv", () => {
  it("parses comments, export prefix, single/double quotes, escapes, inline comments, and duplicate overrides", () => {
    const raw = [
      "\uFEFF# Top comment",
      "",
      "AI_PROVIDER=mock # trailing inline comment",
      "export BASELINE_DATE='2025-10-01'",
      'QUOTED="hello\\nworld \\"ok\\" # keep hash"',
      "HASH_IN_SINGLE='value # preserved'",
      "SYNC_MAX_BATCHES=15",
      "SYNC_MAX_BATCHES=25",
    ].join("\n");

    const parsed = parseDotEnv(raw);
    expect(parsed.AI_PROVIDER).toBe("mock");
    expect(parsed.BASELINE_DATE).toBe("2025-10-01");
    expect(parsed.QUOTED).toBe('hello\nworld "ok" # keep hash');
    expect(parsed.HASH_IN_SINGLE).toBe("value # preserved");
    expect(parsed.SYNC_MAX_BATCHES).toBe("25");
  });
});

describe("resolveAppConfig", () => {
  it("enforces precedence: CLI flags > --env-file > shell env > DOTENV > .env.local > .env > defaults", () => {
    const repoRoot = makeTempDir("cfg-root-");
    const subDir = join(repoRoot, "configs");
    mkdirSync(subDir, { recursive: true });

    writeFileSync(
      join(repoRoot, ".env"),
      [
        "AI_PROVIDER=google",
        "AI_MODEL=gemini-2.5-flash",
        "DATA_DIR=./data-from-dotenv",
        "SYNC_MAX_BATCHES=10",
        "SYNC_COMMIT=true",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(repoRoot, ".env.local"),
      [
        "AI_PROVIDER=openai",
        "SYNC_MAX_BATCHES=12",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(subDir, ".env.debug"),
      [
        "AI_PROVIDER=mock",
        "DATA_DIR=../custom-data",
        "SYNC_MAX_BATCHES=3",
        "SYNC_COMMIT=false",
      ].join("\n"),
      "utf8",
    );

    // 1. .env.local overrides .env; shell env overrides both
    const envOnly = resolveAppConfig(
      {},
      {
        repoRoot,
        callerCwd: repoRoot,
        env: { SYNC_MAX_BATCHES: "30", DEEPSEEK_API_KEY: "sk-secret" },
        applyToProcessEnv: false,
      },
    );
    expect(envOnly.aiProvider).toBe("openai"); // from .env.local
    expect(envOnly.aiModel).toBe("gemini-2.5-flash"); // from .env
    expect(envOnly.syncMaxBatches).toBe(30); // from shell env
    expect(envOnly.dataDir).toBe(join(repoRoot, "data-from-dotenv")); // resolved relative to .env dir

    // 2. --env-file overrides shell env, .env.local, .env; paths resolve relative to --env-file dir
    const withEnvFile = resolveAppConfig(
      { envFile: "configs/.env.debug" },
      {
        repoRoot,
        callerCwd: repoRoot,
        env: { AI_PROVIDER: "anthropic", SYNC_MAX_BATCHES: "30" },
        applyToProcessEnv: false,
      },
    );
    expect(withEnvFile.aiProvider).toBe("mock"); // from configs/.env.debug
    expect(withEnvFile.syncMaxBatches).toBe(3);
    expect(withEnvFile.syncCommit).toBe(false);
    expect(withEnvFile.dataDir).toBe(join(repoRoot, "custom-data")); // ../custom-data relative to configs/

    // 3. CLI flags beat everything, and CLI relative paths resolve against callerCwd
    const callerCwd = makeTempDir("cfg-caller-");
    const withCli = resolveAppConfig(
      {
        envFile: join(repoRoot, "configs/.env.debug"),
        provider: "deepseek",
        data: "./cli-data",
        maxBatches: 5,
        commitChanges: true,
      },
      {
        repoRoot,
        callerCwd,
        env: { AI_PROVIDER: "openai" },
        applyToProcessEnv: false,
      },
    );
    expect(withCli.aiProvider).toBe("deepseek");
    expect(withCli.dataDir).toBe(join(callerCwd, "cli-data"));
    expect(withCli.syncMaxBatches).toBe(5);
    expect(withCli.syncCommit).toBe(true);

    // 4. Built-in defaults, JOBS & token budgets
    const emptyRepo = makeTempDir("cfg-empty-");
    const defaultCfg = resolveAppConfig({}, { repoRoot: emptyRepo, callerCwd, env: {}, applyToProcessEnv: false });
    expect(defaultCfg.upstreamKind).toBe("remote");
    expect(defaultCfg.upstreamRepo).toBe("https://github.com/riscv/riscv-isa-manual.git");
    expect(defaultCfg.upstreamRepoUrl).toBe("https://github.com/riscv/riscv-isa-manual");
    expect(defaultCfg.dataDir).toBe(join(emptyRepo, ".work", "data"));
    expect(defaultCfg.dataRemote).toBe("template");
    expect(defaultCfg.aiProvider).toBe("openai");
    expect(defaultCfg.publish).toBe(true);
    expect(defaultCfg.jobs).toBe(defaultJobs());
    expect(defaultCfg.syncMaxBatches).toBeUndefined();
    expect(defaultCfg.syncFailFast).toBe(false);
    expect(defaultCfg.aiReasoningEffort).toBeUndefined();
    expect(defaultCfg.aiConcurrency).toBe(DEFAULT_AI_CONCURRENCY);
    expect(defaultCfg.aiMaxInputTokens).toBe(DEFAULT_AI_MAX_INPUT_TOKENS);
    expect(defaultCfg.aiMaxOutputTokens).toBe(DEFAULT_AI_MAX_OUTPUT_TOKENS);
    expect(formatConfigForDisplay(defaultCfg, {}).syncMaxBatches).toBeNull();
    expect(formatConfigForDisplay(defaultCfg, {}).syncFailFast).toBe(false);
    expect(formatConfigForDisplay(defaultCfg, {}).aiReasoningEffort).toBe("(provider default)");
    expect(formatConfigForDisplay(defaultCfg, {}).aiConcurrency).toBe(DEFAULT_AI_CONCURRENCY);
    expect(formatConfigForDisplay(defaultCfg, {}).aiMaxInputTokens).toBe(DEFAULT_AI_MAX_INPUT_TOKENS);
    expect(formatConfigForDisplay(defaultCfg, {}).aiMaxOutputTokens).toBe(DEFAULT_AI_MAX_OUTPUT_TOKENS);

    // 5. Reasoning effort & LLM concurrency precedence (defaults -> env -> CLI)
    const upperEffortCfg = resolveAppConfig(
      {},
      {
        repoRoot: emptyRepo,
        callerCwd,
        env: { AI_REASONING_EFFORT: "HIGH", AI_CONCURRENCY: "4" },
        applyToProcessEnv: false,
      },
    );
    expect(upperEffortCfg.aiReasoningEffort).toBe("high");
    expect(upperEffortCfg.aiConcurrency).toBe(4);
    expect(formatConfigForDisplay(upperEffortCfg, { AI_REASONING_EFFORT: "HIGH", AI_CONCURRENCY: "4" }).aiReasoningEffort).toBe("high");
    expect(formatConfigForDisplay(upperEffortCfg, { AI_REASONING_EFFORT: "HIGH", AI_CONCURRENCY: "4" }).aiConcurrency).toBe(4);

    const cliEffortCfg = resolveAppConfig(
      { reasoningEffort: "low", llmConcurrency: 3 },
      {
        repoRoot: emptyRepo,
        callerCwd,
        env: { AI_REASONING_EFFORT: "medium", AI_CONCURRENCY: "4" },
        applyToProcessEnv: false,
      },
    );
    expect(cliEffortCfg.aiReasoningEffort).toBe("low");
    expect(cliEffortCfg.aiConcurrency).toBe(3);

    // Implicit CI detection (CI=1, CI=true, GITHUB_ACTIONS=true) enables syncFailFast unless overridden
    expect(resolveAppConfig({}, { repoRoot: emptyRepo, callerCwd, env: { CI: "1" }, applyToProcessEnv: false }).syncFailFast).toBe(true);
    expect(resolveAppConfig({}, { repoRoot: emptyRepo, callerCwd, env: { CI: "true" }, applyToProcessEnv: false }).syncFailFast).toBe(true);
    expect(resolveAppConfig({}, { repoRoot: emptyRepo, callerCwd, env: { GITHUB_ACTIONS: "true" }, applyToProcessEnv: false }).syncFailFast).toBe(true);
    expect(
      resolveAppConfig({}, { repoRoot: emptyRepo, callerCwd, env: { CI: "1", SYNC_FAIL_FAST: "false" }, applyToProcessEnv: false }).syncFailFast,
    ).toBe(false);
    expect(
      resolveAppConfig({}, { repoRoot: emptyRepo, callerCwd, env: { SYNC_FAIL_FAST: "true" }, applyToProcessEnv: false }).syncFailFast,
    ).toBe(true);
    expect(
      resolveAppConfig({ failFast: true }, { repoRoot: emptyRepo, callerCwd, env: { SYNC_FAIL_FAST: "false" }, applyToProcessEnv: false }).syncFailFast,
    ).toBe(true);
    expect(
      resolveAppConfig({ failFast: false }, { repoRoot: emptyRepo, callerCwd, env: { CI: "1", SYNC_FAIL_FAST: "true" }, applyToProcessEnv: false }).syncFailFast,
    ).toBe(false);
    expect(
      resolveAppConfig({}, { repoRoot, callerCwd, env: { JOBS: "3", AI_MAX_INPUT_TOKENS: "500000", AI_MAX_OUTPUT_TOKENS: "24000" }, applyToProcessEnv: false }),
    ).toMatchObject({
      jobs: 3,
      aiMaxInputTokens: 500_000,
      aiMaxOutputTokens: 24_000,
    });
    expect(
      resolveAppConfig(
        { jobs: 2, maxInputTokens: 200_000, maxOutputTokens: 8_000 },
        { repoRoot, callerCwd, env: { JOBS: "6", AI_MAX_INPUT_TOKENS: "500000", AI_MAX_OUTPUT_TOKENS: "24000" }, applyToProcessEnv: false },
      ),
    ).toMatchObject({
      jobs: 2,
      aiMaxInputTokens: 200_000,
      aiMaxOutputTokens: 8_000,
    });
  });

  it("throws on invalid numeric/boolean values and missing --env-file", () => {
    const repoRoot = makeTempDir("cfg-invalid-");
    expect(() =>
      resolveAppConfig(
        { envFile: "./does-not-exist.env" },
        { repoRoot, callerCwd: repoRoot, env: {}, applyToProcessEnv: false },
      ),
    ).toThrow("Env file not found");

    expect(() =>
      resolveAppConfig(
        {},
        { repoRoot, callerCwd: repoRoot, env: { SYNC_MAX_BATCHES: "0" }, applyToProcessEnv: false },
      ),
    ).toThrow("Invalid SYNC_MAX_BATCHES");

    expect(() =>
      resolveAppConfig(
        {},
        { repoRoot, callerCwd: repoRoot, env: { AI_MAX_INPUT_TOKENS: "0" }, applyToProcessEnv: false },
      ),
    ).toThrow("Invalid AI_MAX_INPUT_TOKENS");

    expect(() =>
      resolveAppConfig(
        {},
        { repoRoot, callerCwd: repoRoot, env: { AI_MAX_OUTPUT_TOKENS: "0" }, applyToProcessEnv: false },
      ),
    ).toThrow("Invalid AI_MAX_OUTPUT_TOKENS");

    expect(() =>
      resolveAppConfig(
        { maxInputTokens: 0 },
        { repoRoot, callerCwd: repoRoot, env: {}, applyToProcessEnv: false },
      ),
    ).toThrow("Invalid --max-input-tokens");

    expect(() =>
      resolveAppConfig(
        { maxOutputTokens: 0 },
        { repoRoot, callerCwd: repoRoot, env: {}, applyToProcessEnv: false },
      ),
    ).toThrow("Invalid --max-output-tokens");

    expect(() =>
      resolveAppConfig(
        {},
        { repoRoot, callerCwd: repoRoot, env: { JOBS: "0" }, applyToProcessEnv: false },
      ),
    ).toThrow("Invalid JOBS");

    expect(() =>
      resolveAppConfig(
        { jobs: 0 },
        { repoRoot, callerCwd: repoRoot, env: {}, applyToProcessEnv: false },
      ),
    ).toThrow("Invalid --jobs");

    expect(() =>
      resolveAppConfig(
        {},
        { repoRoot, callerCwd: repoRoot, env: { SYNC_COMMIT: "maybe" }, applyToProcessEnv: false },
      ),
    ).toThrow("Invalid SYNC_COMMIT");

    expect(() =>
      resolveAppConfig(
        {},
        { repoRoot, callerCwd: repoRoot, env: { SYNC_FAIL_FAST: "maybe" }, applyToProcessEnv: false },
      ),
    ).toThrow("Invalid SYNC_FAIL_FAST");

    expect(() =>
      resolveAppConfig(
        {},
        { repoRoot, callerCwd: repoRoot, env: { AI_REASONING_EFFORT: "turbo" }, applyToProcessEnv: false },
      ),
    ).toThrow("Invalid AI_REASONING_EFFORT");

    expect(() =>
      resolveAppConfig(
        { reasoningEffort: "" },
        { repoRoot, callerCwd: repoRoot, env: {}, applyToProcessEnv: false },
      ),
    ).toThrow("Invalid --reasoning-effort");

    expect(() =>
      resolveAppConfig(
        {},
        { repoRoot, callerCwd: repoRoot, env: { AI_CONCURRENCY: "0" }, applyToProcessEnv: false },
      ),
    ).toThrow("Invalid AI_CONCURRENCY");

    expect(() =>
      resolveAppConfig(
        {},
        { repoRoot, callerCwd: repoRoot, env: { AI_CONCURRENCY: "-1" }, applyToProcessEnv: false },
      ),
    ).toThrow("Invalid AI_CONCURRENCY");

    expect(() =>
      resolveAppConfig(
        {},
        { repoRoot, callerCwd: repoRoot, env: { AI_CONCURRENCY: "abc" }, applyToProcessEnv: false },
      ),
    ).toThrow("Invalid AI_CONCURRENCY");

    expect(() =>
      resolveAppConfig(
        { llmConcurrency: 0 },
        { repoRoot, callerCwd: repoRoot, env: {}, applyToProcessEnv: false },
      ),
    ).toThrow("Invalid --llm-concurrency");
  });

  it("parses --fail-fast and --no-fail-fast CLI flags and rejects combining both", () => {
    const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
    const baseEnv: Record<string, string> = {
      ...process.env,
      RISCV_CN_NO_DOTENV: "1",
    };
    delete baseEnv.CI;
    delete baseEnv.GITHUB_ACTIONS;
    delete baseEnv.SYNC_FAIL_FAST;

    const failFastOn = Bun.spawnSync(
      ["bun", cliPath, "config", "--fail-fast"],
      { cwd: MONOREPO_ROOT, env: baseEnv, stdout: "pipe", stderr: "pipe" },
    );
    expect(failFastOn.exitCode).toBe(0);
    expect(JSON.parse(failFastOn.stdout.toString("utf8")).syncFailFast).toBe(true);

    const failFastOff = Bun.spawnSync(
      ["bun", cliPath, "config", "--no-fail-fast"],
      { cwd: MONOREPO_ROOT, env: { ...baseEnv, CI: "1" }, stdout: "pipe", stderr: "pipe" },
    );
    expect(failFastOff.exitCode).toBe(0);
    expect(JSON.parse(failFastOff.stdout.toString("utf8")).syncFailFast).toBe(false);

    const both = Bun.spawnSync(
      ["bun", cliPath, "config", "--fail-fast", "--no-fail-fast"],
      { cwd: MONOREPO_ROOT, env: baseEnv, stdout: "pipe", stderr: "pipe" },
    );
    expect(both.exitCode).not.toBe(0);
    expect(both.stderr.toString("utf8")).toContain("Cannot combine --fail-fast and --no-fail-fast");
  });

  it("derives dataRepo, dataRemote, dataRepoUrl from GITHUB_REPOSITORY_OWNER and enables syncFailFast in CI", () => {
    const root = makeTempDir("cfg-ci-");
    const ci = resolveAppConfig(
      {},
      { repoRoot: root, callerCwd: root, env: { CI: "true", GITHUB_REPOSITORY_OWNER: "acme" }, applyToProcessEnv: false },
    );
    expect(ci.upstreamKind).toBe("remote");
    expect(ci.syncFailFast).toBe(true);
    expect(ci.publish).toBe(true);
    expect(ci.dataDir).toBe(join(root, ".work", "data"));
    expect(ci.dataRepo).toBe("acme/riscv-isa-manual-cn-data");
    expect(ci.dataRemote).toBe("https://github.com/acme/riscv-isa-manual-cn-data.git");
    expect(ci.dataRepoUrl).toBe("https://github.com/acme/riscv-isa-manual-cn-data");
  });

  it("layers .env < .env.local < DOTENV < shell < --env-file < CLI flags, ignoring blank values", () => {
    const root = makeTempDir("cfg-layers-");
    writeFileSync(join(root, ".env"), "AI_PROVIDER=mock\nSYNC_MAX_BATCHES=11\nAI_MODEL=from-dotenv\n");
    writeFileSync(join(root, ".env.local"), "SYNC_MAX_BATCHES=12\nAI_PROVIDER=\n");

    const a = resolveAppConfig({}, { repoRoot: root, callerCwd: root, env: {}, applyToProcessEnv: false });
    expect(a.aiProvider).toBe("mock"); // blank AI_PROVIDER in .env.local ignored
    expect(a.syncMaxBatches).toBe(12);
    expect(a.aiModel).toBe("from-dotenv");
    expect(a.valueOrigins.AI_PROVIDER).toBe(join(root, ".env"));

    const b = resolveAppConfig(
      {},
      {
        repoRoot: root,
        callerCwd: root,
        env: { DOTENV: "SYNC_MAX_BATCHES=13\nAI_MODEL=from-blob\n", AI_MODEL: "", SYNC_MAX_BATCHES: "14" },
        applyToProcessEnv: false,
      },
    );
    expect(b.syncMaxBatches).toBe(14); // shell beats DOTENV
    expect(b.aiModel).toBe("from-blob"); // blank shell AI_MODEL (e.g. empty GitHub var) ignored
    expect(b.valueOrigins.AI_MODEL).toBe("DOTENV");

    const envFile = join(root, "override.env");
    writeFileSync(envFile, "AI_MODEL=from-env-file\nSYNC_MAX_BATCHES=15\n");
    const c = resolveAppConfig(
      { envFile: "override.env", maxBatches: 16 },
      {
        repoRoot: root,
        callerCwd: root,
        env: { DOTENV: "AI_MODEL=from-blob\n", SYNC_MAX_BATCHES: "14" },
        applyToProcessEnv: false,
      },
    );
    expect(c.aiModel).toBe("from-env-file");
    expect(c.valueOrigins.AI_MODEL).toBe(envFile);
    expect(c.syncMaxBatches).toBe(16);
  });

  it("RISCV_CN_NO_DOTENV skips personal .env and .env.local files", () => {
    const root = makeTempDir("cfg-nodotenv-");
    writeFileSync(join(root, ".env"), "AI_PROVIDER=mock\n");
    writeFileSync(join(root, ".env.local"), "AI_MODEL=custom-model\n");
    const cfg = resolveAppConfig({}, { repoRoot: root, callerCwd: root, env: { RISCV_CN_NO_DOTENV: "1" }, applyToProcessEnv: false });
    expect(cfg.aiProvider).toBe("openai");
    expect(cfg.aiModel).toBeUndefined();
    expect(cfg.loadedEnvFiles).toEqual([]);
  });

  it("WORK_DIR relocates fixture, mirror and default data dir; DATA_DIR still wins", () => {
    const root = makeTempDir("cfg-work-root-");
    const work = makeTempDir("cfg-work-");
    const cfg = resolveAppConfig({}, { repoRoot: root, callerCwd: root, env: { UPSTREAM_REPO: "fixture", WORK_DIR: work }, applyToProcessEnv: false });
    expect(cfg.upstreamRepo).toBe(join(work, "upstream-fixture"));
    expect(cfg.upstreamMirrorDir).toBe(join(work, "upstream.git"));
    expect(cfg.dataDir).toBe(join(work, "data"));
    const explicit = resolveAppConfig({ data: "./mine" }, { repoRoot: root, callerCwd: root, env: { WORK_DIR: work }, applyToProcessEnv: false });
    expect(explicit.dataDir).toBe(join(root, "mine"));
  });

  it("derives upstreamRepoUrl from remote UPSTREAM_REPO unless overridden and honors PUBLISH=false", () => {
    const root = makeTempDir("cfg-upstream-url-");
    const derived = resolveAppConfig(
      {},
      { repoRoot: root, callerCwd: root, env: { UPSTREAM_REPO: "https://example.org/acme/manual.git/", PUBLISH: "false" }, applyToProcessEnv: false },
    );
    expect(derived.upstreamRepoUrl).toBe("https://example.org/acme/manual");
    expect(derived.publish).toBe(false);

    const overridden = resolveAppConfig(
      { upstreamRepoUrl: "https://mirror.example.org/manual" },
      { repoRoot: root, callerCwd: root, env: { UPSTREAM_REPO: "fixture" }, applyToProcessEnv: false },
    );
    expect(overridden.upstreamRepoUrl).toBe("https://mirror.example.org/manual");
  });

  it("redacts API keys in formatConfigForDisplay output", () => {
    const repoRoot = makeTempDir("cfg-redact-");
    const cfg = resolveAppConfig(
      {},
      {
        repoRoot,
        callerCwd: repoRoot,
        env: {
          DEEPSEEK_API_KEY: "sk-live-very-secret",
          OPENAI_API_KEY: "",
          LANGSMITH_API_KEY: "lsv2-pt-secret",
        },
        applyToProcessEnv: false,
      },
    );

    const display = formatConfigForDisplay(cfg, {
      DEEPSEEK_API_KEY: "sk-live-very-secret",
      OPENAI_API_KEY: "",
      LANGSMITH_API_KEY: "lsv2-pt-secret",
    });
    const serialized = JSON.stringify(display);
    expect(serialized).not.toContain("sk-live-very-secret");
    expect(serialized).not.toContain("lsv2-pt-secret");
    expect(display.apiKeys).toEqual({
      DEEPSEEK_API_KEY: "(set)",
      GOOGLE_GENERATIVE_AI_API_KEY: "(not set)",
      OPENAI_API_KEY: "(not set)",
      ANTHROPIC_API_KEY: "(not set)",
      LANGSMITH_API_KEY: "(set)",
    });
  });

  it("resolves provider-specific base URLs and detects LANGCHAIN_API_KEY in display output", () => {
    const root = makeTempDir("cfg-provider-base-");
    const env: Record<string, string | undefined> = {
      DOTENV: "AI_MODEL=from-dotenv\nAI_BASE_URL=https://generic.example.test/v1\n",
      AI_PROVIDER: "openai",
      OPENAI_BASE_URL: "https://openai-specific.example.test/v1",
      LANGCHAIN_API_KEY: "lsv2-legacy",
    };

    const cfg = resolveAppConfig({}, { repoRoot: root, callerCwd: root, env, applyToProcessEnv: false });
    expect(cfg.aiProvider).toBe("openai");
    expect(cfg.aiModel).toBe("from-dotenv");
    expect(cfg.aiBaseUrl).toBe("https://openai-specific.example.test/v1");

    const cliBaseUrlCfg = resolveAppConfig(
      { baseUrl: "https://cli-override.example.test/v1" },
      { repoRoot: root, callerCwd: root, env, applyToProcessEnv: false },
    );
    expect(cliBaseUrlCfg.aiBaseUrl).toBe("https://cli-override.example.test/v1");

    const display = formatConfigForDisplay(cfg, env);
    expect(display.aiBaseUrl).toBe("https://openai-specific.example.test/v1");
    expect((display.apiKeys as Record<string, string>).LANGSMITH_API_KEY).toBe("(set)");
  });

  it("applies VERBOSE loaded from DOTENV in CLI", () => {
    const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
    const dataDir = makeTempDir("cfg-verbose-data-");
    mkdirSync(join(dataDir, "manifests"), { recursive: true });
    writeFileSync(join(dataDir, "GLOSSARY.md"), "# Glossary\n", "utf8");
    writeFileSync(
      join(dataDir, "manifests", "index.json"),
      JSON.stringify({
        upstream_repo: "https://github.com/riscv/riscv-isa-manual.git",
        baseline_cutoff: "2025-05-08",
        last_synced_sha: null,
        known_tags: {},
        commits: [],
      }),
      "utf8",
    );

    const baseEnv: Record<string, string> = {
      ...process.env,
      RISCV_CN_NO_DOTENV: "1",
    };
    delete baseEnv.VERBOSE;
    delete baseEnv.DOTENV;

    const quiet = Bun.spawnSync(
      ["bun", cliPath, "validate-data", "--data", dataDir],
      { cwd: MONOREPO_ROOT, env: baseEnv, stdout: "pipe", stderr: "pipe" },
    );
    expect(quiet.exitCode).toBe(0);
    expect(quiet.stderr.toString("utf8")).not.toContain("validate: checking");

    const verboseFromDotenv = Bun.spawnSync(
      ["bun", cliPath, "validate-data", "--data", dataDir],
      {
        cwd: MONOREPO_ROOT,
        env: { ...baseEnv, DOTENV: "VERBOSE=1\n" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(verboseFromDotenv.exitCode).toBe(0);
    expect(verboseFromDotenv.stderr.toString("utf8")).toContain("validate: checking");
  });
});
