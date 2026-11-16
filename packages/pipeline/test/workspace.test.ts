import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManifestIndexSchema } from "@riscv-cn/schema";
import { MONOREPO_ROOT, resolveAppConfig, type AppConfig } from "../src/config.ts";
import { createFixtureUpstream } from "../src/dev/fixture.ts";
import { runSyncJob, runSyncStep } from "../src/jobs/index.ts";
import { setGenerateObjectForTest } from "../src/translate/index.ts";
import { ensureData, ensureUpstream, publishData, resetData } from "../src/workspace/index.ts";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  setGenerateObjectForTest(undefined);
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const silent = () => {};

function git(args: string[], cwd: string): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function localCfg(work: string, env: Record<string, string> = {}): AppConfig {
  return resolveAppConfig(
    {},
    {
      repoRoot: MONOREPO_ROOT,
      callerCwd: MONOREPO_ROOT,
      env: { UPSTREAM_REPO: "fixture", DATA_REMOTE: "template", AI_PROVIDER: "mock", WORK_DIR: work, ...env },
      applyToProcessEnv: false,
      ignoreDotEnvFiles: true,
    },
  );
}

describe("fixture upstream", () => {
  it("is deterministic: identical SHAs on every machine and run", () => {
    const a = createFixtureUpstream(makeTempDir("fx-a-"));
    const b = createFixtureUpstream(makeTempDir("fx-b-"));
    expect(a).toHaveLength(3);
    expect(a).toEqual(b);
  });
});

describe("workspace", () => {
  it("prepares fixture + template data, syncs with mock, and is idempotent", async () => {
    const work = makeTempDir("ws-");
    const cfg = localCfg(work);

    const upstream = ensureUpstream(cfg, { log: silent });
    expect(upstream).toBe(join(work, "upstream-fixture"));
    const first = ensureData(cfg, silent);
    expect(first.created).toBe(true);
    expect(existsSync(join(cfg.dataDir, ".github", "workflows", "deploy.yml"))).toBe(true);
    expect(git(["log", "--format=%s"], cfg.dataDir)).toContain("initialize data repository from template");

    const second = ensureData(cfg, silent);
    expect(second.created).toBe(false);

    const result = await runSyncStep(cfg, upstream);
    expect(result.processedCommits).toBe(3);
    expect(result.translatedUnits).toBeGreaterThan(0);
    const index = ManifestIndexSchema.parse(
      JSON.parse(readFileSync(join(cfg.dataDir, "manifests", "index.json"), "utf8")),
    );
    expect(index.commits.map((c) => c.ratified_tag)).toContain("20240411");

    const again = await runSyncStep(cfg, ensureUpstream(cfg, { log: silent }));
    expect(again).toEqual({ processedCommits: 0, translatedUnits: 0, hasRemaining: false });
  });

  it("refuses to sync a data repo against an upstream it was not synced from", async () => {
    const work = makeTempDir("ws-mismatch-");
    const cfg = localCfg(work);
    await runSyncStep(cfg, (ensureData(cfg, silent), ensureUpstream(cfg, { log: silent })));

    const other = makeTempDir("ws-other-up-");
    createFixtureUpstream(other, [
      { date: "2024-05-01T00:00:00+00:00", message: "unrelated", files: { "src/riscv-unprivileged.adoc": "= X\n\n== Y\n\nZ." } },
    ]);
    await expect(runSyncStep(cfg, other)).rejects.toThrow("do not belong together");
  });

  it("resetData guards outside WORK_DIR unless missing or an initialised data repo with --yes", () => {
    const work = makeTempDir("ws-reset-");
    const outside = makeTempDir("ws-outside-");

    // Non-empty uninitialised directory outside WORK_DIR is never deleted, even with --yes.
    writeFileSync(join(outside, "keep.txt"), "keep");
    const badCfg = localCfg(work, { DATA_DIR: outside });
    expect(() => resetData(badCfg, silent)).toThrow("Refusing to delete DATA_DIR outside WORK_DIR");
    expect(() => resetData(badCfg, silent, { yes: true })).toThrow("Refusing to delete DATA_DIR outside WORK_DIR");
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);

    // Non-existent DATA_DIR outside WORK_DIR has nothing to delete and is initialised directly.
    const newData = join(outside, "new-data");
    const missingCfg = localCfg(work, { DATA_DIR: newData });
    const created = resetData(missingCfg, silent);
    expect(created.created).toBe(true);
    expect(existsSync(join(newData, "manifests", "index.json"))).toBe(true);

    // Initialised data repo outside WORK_DIR requires --yes, resets cleanly, and keeps origin remote.
    git(["remote", "add", "origin", "https://example.com/org/data.git"], newData);
    writeFileSync(join(newData, "GLOSSARY.md"), "# modified\n");
    expect(() => resetData(missingCfg, silent)).toThrow("Pass --yes");
    const reset = resetData(missingCfg, silent, { yes: true });
    expect(reset.created).toBe(true);
    expect(readFileSync(join(newData, "GLOSSARY.md"), "utf8")).not.toBe("# modified\n");
    expect(git(["remote", "get-url", "origin"], newData)).toBe("https://example.com/org/data.git");
  });

  it("clones DATA_REMOTE, publishes as a dry run by default, and pushes only when allowed", () => {
    const work = makeTempDir("ws-publish-");
    const remote = join(makeTempDir("ws-remote-"), "data.git");

    // Seed a bare "real" data repo from the template.
    const seedCfg = localCfg(work, { DATA_DIR: join(work, "seed") });
    ensureData(seedCfg, silent);
    git(["clone", "--quiet", "--bare", seedCfg.dataDir, remote], work);

    const cfg = localCfg(work, { DATA_REMOTE: remote, DATA_DIR: join(work, "clone") });
    const res = ensureData(cfg, silent);
    expect(res.source).toBe(remote);

    writeFileSync(join(cfg.dataDir, "GLOSSARY.md"), "# changed\n");
    git(["commit", "--quiet", "-am", "review: tweak glossary"], cfg.dataDir);

    const dry = publishData(cfg, { log: silent });
    expect(dry.pushed).toBe(false); // outside CI requires --yes
    expect(dry.pending).toHaveLength(1);

    const disabled = publishData({ ...cfg, publish: false }, { yes: true, log: silent });
    expect(disabled.pushed).toBe(false); // PUBLISH=false disables push even with --yes

    const pushed = publishData(cfg, { yes: true, log: silent });
    expect(pushed.pushed).toBe(true);
    expect(git(["log", "-1", "--format=%s", "main"], remote)).toBe("review: tweak glossary");
  });

  it("errors clearly when DATA_DIR is a non-empty, non-data directory", () => {
    const work = makeTempDir("ws-bad-");
    const bad = join(work, "data");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "random.txt"), "x");
    expect(() => ensureData(localCfg(work), silent)).toThrow("not an initialised data repository");
  });

  it("runSyncJob validates and pushes [skip ci] checkpoints when fail-fast aborts, and skips push if validation fails", async () => {
    const work = makeTempDir("ws-ff-job-");
    const upstream = makeTempDir("ws-ff-up-");
    createFixtureUpstream(upstream, [
      {
        date: "2024-05-01T00:00:00+00:00",
        message: "feat: two chapters",
        files: {
          "src/riscv-unprivileged.adoc": [
            "= Spec",
            "",
            "== Short Chapter",
            "",
            "Short body `x1`.",
            "",
            "== Failing Chapter",
            "",
            "Slightly longer body `x2` that triggers failure here.",
          ].join("\n"),
        },
      },
    ]);

    const setupRemoteData = (name: string) => {
      const seedCfg = localCfg(work, { DATA_DIR: join(work, `seed-${name}`) });
      ensureData(seedCfg, silent);
      const remote = join(work, `remote-${name}.git`);
      git(["clone", "--quiet", "--bare", seedCfg.dataDir, remote], work);
      return remote;
    };

    // 1. Valid checkpoint on fail-fast error -> validate succeeds -> pushed to remote with has_remaining=false
    const remote1 = setupRemoteData("valid");
    const cfg1 = localCfg(work, {
      UPSTREAM_REPO: upstream,
      DATA_REMOTE: remote1,
      DATA_DIR: join(work, "clone-valid"),
      AI_PROVIDER: "google",
      PUBLISH: "true",
      SYNC_FAIL_FAST: "true",
    });

    let calls1 = 0;
    setGenerateObjectForTest(async (opts) => {
      calls1++;
      if (calls1 === 2) throw new Error("simulated mid-run outage");
      const matches = [
        ...opts.messages[0].content.matchAll(/<unit id="([0-9a-f]{32})" kind="[^"]+">\n([\s\S]*?)\n<\/unit>/g),
      ];
      return {
        object: { translations: matches.map((m) => ({ unit_id: m[1], zh: `[ZH] ${m[2]}` })) },
      };
    });

    const ghOutputPath = join(work, "github_output.txt");
    const ghSummaryPath = join(work, "github_summary.md");
    writeFileSync(ghOutputPath, "", "utf8");
    writeFileSync(ghSummaryPath, "", "utf8");
    const prevGhOutput = process.env.GITHUB_OUTPUT;
    const prevGhSummary = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_OUTPUT = ghOutputPath;
    process.env.GITHUB_STEP_SUMMARY = ghSummaryPath;
    try {
      await expect(runSyncJob(cfg1, { yes: true, log: silent })).rejects.toThrow("simulated mid-run outage");
    } finally {
      if (prevGhOutput === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = prevGhOutput;
      if (prevGhSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
      else process.env.GITHUB_STEP_SUMMARY = prevGhSummary;
    }

    expect(calls1).toBe(2);
    const ghOutput = readFileSync(ghOutputPath, "utf8");
    expect(ghOutput).toContain("has_remaining=false");
    expect(ghOutput).toContain("made_progress=true");
    expect(ghOutput).toContain("pushed=true");
    const ghSummary = readFileSync(ghSummaryPath, "utf8");
    expect(ghSummary).toContain("### Sync Summary");
    expect(ghSummary).toContain("| Validation | passed |");
    expect(ghSummary).toContain("| Published | pushed (");
    expect(git(["log", "-1", "--format=%s", "main"], remote1)).toContain("[skip ci]");
    expect(git(["ls-tree", "-r", "--name-only", "main", "--", "units/"], remote1)).not.toBe("");

    // 2. Corrupted data on fail-fast error -> validate fails -> skips publishData
    const remote2 = setupRemoteData("invalid");
    const initialRemoteRev = git(["rev-parse", "main"], remote2);
    const cfg2 = localCfg(work, {
      UPSTREAM_REPO: upstream,
      DATA_REMOTE: remote2,
      DATA_DIR: join(work, "clone-invalid"),
      AI_PROVIDER: "google",
      PUBLISH: "true",
      SYNC_FAIL_FAST: "true",
    });

    let calls2 = 0;
    setGenerateObjectForTest(async () => {
      calls2++;
      mkdirSync(join(cfg2.dataDir, "units", "00"), { recursive: true });
      writeFileSync(join(cfg2.dataDir, "units", "00", "corrupt.toml"), "invalid toml = [[[\n", "utf8");
      throw new Error("outage with bad data");
    });

    const logs2: string[] = [];
    await expect(runSyncJob(cfg2, { yes: true, log: (m) => logs2.push(m) })).rejects.toThrow("outage with bad data");
    expect(calls2).toBe(1);
    expect(logs2.some((m) => m.includes("publish: skipped because validation failed"))).toBe(true);
    expect(git(["rev-parse", "main"], remote2)).toBe(initialRemoteRev);
  });
});
