import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnchorIndexSchema,
  ChapterStructureSchema,
  ChapterUnitPackSchema,
  ManifestIndexSchema,
  SearchEntrySchema,
  SiteIndexSchema,
  SiteTreeSchema,
  UnitMetaShardSchema,
} from "@riscv-cn/schema";
import { buildSiteData } from "../src/build-site/index.ts";
import { readHydratedSnapshot, writeHydratedSnapshot } from "../src/manifests/index.ts";
import { contentAddressedAssetName, gitBlobSha1 } from "../src/resources.ts";
import { runSync } from "../src/sync/index.ts";
import { parseUnitToml, serializeUnitToml, unitRelPath } from "../src/toml/index.ts";
import { setGenerateObjectForTest } from "../src/translate/index.ts";
import { validateDataRepo } from "../src/validate/index.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function matchPromptChapterHeading(userPrompt: string): RegExpMatchArray | null {
  return (
    userPrompt.match(/<unit id="[0-9a-f]{32}" kind="heading">\n([^\n]+)\n<\/unit>/) ??
    userPrompt.match(/^== (.+)$/m)
  );
}

function git(args: string[], cwd: string): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString("utf8")}`);
  }
  return proc.stdout.toString("utf8").trim();
}

function initGitRepo(dir: string): void {
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test User"], dir);
}

afterEach(() => {
  setGenerateObjectForTest(undefined);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("sync, validate, and build-site integration", () => {
  it("syncs multi-commit upstream repo, handles incremental review status, validates, and builds site artifacts", async () => {
    const upstreamDir = makeTempDir("riscv-upstream-fixture-");
    const dataDir = makeTempDir("riscv-data-fixture-");
    const outDir = makeTempDir("riscv-site-out-");

    // 1. Create upstream fixture git repo with 2 commits + tags
    initGitRepo(upstreamDir);
    mkdirSync(join(upstreamDir, "src"), { recursive: true });

    const commit1Adoc = [
      "= RISC-V Unprivileged Specification",
      "",
      "== RV32I Base Integer Instruction Set",
      "",
      "RV32I provides 32 general-purpose registers `x0` through `x31`.",
      "",
      "The `ADD` instruction adds two registers and writes `rd`.",
      "",
      "[source,asm]",
      "----",
      "add x1, x2, x3",
      "----",
      "",
      "|===",
      "| Field | Bits",
      "| `rd` | 11:7",
      "|===",
    ].join("\n");

    writeFileSync(join(upstreamDir, "src", "riscv-unprivileged.adoc"), commit1Adoc, "utf8");
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "feat: initial rv32i chapter"], upstreamDir);
    const sha1 = git(["rev-parse", "HEAD"], upstreamDir);
    git(["tag", "20240411"], upstreamDir);

    const commit2Adoc = [
      "= RISC-V Unprivileged Specification",
      "",
      "== RV32I Base Integer Instruction Set",
      "",
      "RV32I provides 32 general-purpose registers `x0` through `x31`.",
      "",
      "The `ADD` instruction adds two registers and ignores overflow when writing `rd`.",
      "",
      "Register `x0` is hardwired to 0.",
      "",
      "[source,asm]",
      "----",
      "add x1, x2, x3",
      "----",
      "",
      "|===",
      "| Field | Bits",
      "| `rd` | 11:7",
      "|===",
    ].join("\n");

    writeFileSync(join(upstreamDir, "src", "riscv-unprivileged.adoc"), commit2Adoc, "utf8");
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "docs: clarify ADD overflow and x0"], upstreamDir);
    const sha2 = git(["rev-parse", "HEAD"], upstreamDir);
    git(["tag", "riscv-isa-release-20250101"], upstreamDir);

    // 2. Initialize data repo
    initGitRepo(dataDir);
    mkdirSync(join(dataDir, "manifests"), { recursive: true });
    writeFileSync(
      join(dataDir, "GLOSSARY.md"),
      "# Glossary\n\n- `hart` -> 硬件线程\n- `register` -> 寄存器\n",
      "utf8",
    );
    writeFileSync(
      join(dataDir, "manifests", "index.json"),
      JSON.stringify(
        {
          upstream_repo: upstreamDir,
          baseline_cutoff: "2023-06-01",
          last_synced_sha: null,
          known_tags: {},
          commits: [],
        },
        null,
        2,
      ),
      "utf8",
    );
    git(["add", "-A"], dataDir);
    git(["commit", "-m", "chore: init data repo"], dataDir);

    // 3. Initial sync with mock provider
    const sync1 = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "mock",
    });

    expect(sync1.processedCommits).toBe(2);
    expect(sync1.translatedUnits).toBeGreaterThan(0);
    expect(sync1.hasRemaining).toBe(false);

    const indexAfter1 = ManifestIndexSchema.parse(
      JSON.parse(readFileSync(join(dataDir, "manifests", "index.json"), "utf8")),
    );
    expect(indexAfter1.last_synced_sha).toBe(sha2);
    expect(indexAfter1.commits).toHaveLength(2);
    expect(indexAfter1.commits[0].sha).toBe(sha1);
    expect(indexAfter1.commits[0].ratified_tag).toBe("20240411");
    expect(indexAfter1.commits[1].sha).toBe(sha2);
    expect(indexAfter1.commits[1].draft_tags).toEqual(["riscv-isa-release-20250101"]);

    // Fast no-op re-sync
    const syncNoop = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "mock",
    });
    expect(syncNoop).toEqual({
      processedCommits: 0,
      translatedUnits: 0,
      hasRemaining: false,
    });

    // 4. Simulate human reviewer approving the x0 paragraph, then upstream edits it in commit 3
    const unitsDir = join(dataDir, "units");
    let x0UnitId = "";
    for (const prefix of readdirSync(unitsDir)) {
      for (const file of readdirSync(join(unitsDir, prefix))) {
        const parsed = parseUnitToml(readFileSync(join(unitsDir, prefix, file), "utf8"));
        if (parsed.translatable && parsed.en.includes("hardwired to 0")) {
          x0UnitId = parsed.unit_id;
          writeFileSync(
            join(unitsDir, prefix, file),
            serializeUnitToml({
              ...parsed,
              status: "approved",
              zh: "寄存器 `x0` 硬连线为常数 0。",
            }),
            "utf8",
          );
        }
      }
    }
    expect(x0UnitId).toMatch(/^[0-9a-f]{32}$/);
    git(["add", "-A"], dataDir);
    git(["commit", "-m", "review: approve x0 translation"], dataDir);

    const commit3Adoc = commit2Adoc.replace(
      "Register `x0` is hardwired to 0.",
      "Register `x0` is hardwired with all bits equal to 0.",
    );
    writeFileSync(join(upstreamDir, "src", "riscv-unprivileged.adoc"), commit3Adoc, "utf8");
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "docs: reword x0 description"], upstreamDir);
    const sha3 = git(["rev-parse", "HEAD"], upstreamDir);

    const sync2 = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "mock",
    });
    expect(sync2.processedCommits).toBe(1);
    expect(sync2.hasRemaining).toBe(false);

    // Find updated unit and verify machine status (with prev_unit_id tracked in manifest/meta)
    let updatedX0Id = "";
    for (const prefix of readdirSync(unitsDir)) {
      for (const file of readdirSync(join(unitsDir, prefix))) {
        const parsed = parseUnitToml(readFileSync(join(unitsDir, prefix, file), "utf8"));
        if (parsed.en.includes("all bits equal to 0")) {
          updatedX0Id = parsed.unit_id;
          expect(parsed.translatable).toBe(true);
          if (parsed.translatable) {
            expect(parsed.status).toBe("machine");
          }
        }
      }
    }
    expect(updatedX0Id).toMatch(/^[0-9a-f]{32}$/);
    expect(updatedX0Id).not.toBe(x0UnitId);

    // 5. Validate data repository
    const validation = await validateDataRepo(dataDir);
    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.snapshotCount).toBe(3);
    expect(validation.unitCount).toBeGreaterThan(4);

    // 6. Build static viewer site data
    const buildResult = await buildSiteData({
      dataDir,
      outDir,
      dataRepoUrl: "https://github.com/example/riscv-isa-manual-cn-data",
      upstreamRepoUrl: "https://github.com/riscv/riscv-isa-manual",
    });

    expect(buildResult.snapshots).toBe(3);
    expect(buildResult.trees).toBeGreaterThan(0);
    expect(buildResult.chapters).toBeGreaterThan(0);
    expect(buildResult.packs).toBeGreaterThan(0);
    expect(buildResult.units).toBeGreaterThan(4);

    const siteIndex = SiteIndexSchema.parse(
      JSON.parse(readFileSync(join(outDir, "index.json"), "utf8")),
    );
    expect(siteIndex.default_sha).toBe(sha1); // latest ratified tag
    expect(siteIndex.snapshots).toHaveLength(3);
    expect(siteIndex.snapshots[0].is_baseline).toBe(true);
    expect(siteIndex.snapshots[0].diff).toEqual({
      added: 0,
      modified: 0,
      moved: 0,
      deleted: 0,
      touched_chapters: [],
    });
    expect(siteIndex.snapshots[2].sha).toBe(sha3);
    expect(siteIndex.glossary_markdown).toContain("硬件线程");

    const treeFiles = readdirSync(join(outDir, "trees")).filter((f) => f.endsWith(".json"));
    expect(treeFiles.length).toBe(buildResult.trees);
    const defaultTree = SiteTreeSchema.parse(
      JSON.parse(readFileSync(join(outDir, "trees", `${siteIndex.default_tree_hash}.json`), "utf8")),
    );
    expect(defaultTree.volumes.length).toBeGreaterThan(0);

    const structFiles = readdirSync(join(outDir, "chapters")).filter((f) => f.endsWith(".json"));
    expect(structFiles.length).toBe(buildResult.chapters);
    const sampleStruct = ChapterStructureSchema.parse(
      JSON.parse(readFileSync(join(outDir, "chapters", structFiles[0]), "utf8")),
    );
    expect(sampleStruct.sections.length).toBeGreaterThan(0);

    const packFiles = readdirSync(join(outDir, "packs")).filter((f) => f.endsWith(".json"));
    expect(packFiles.length).toBe(buildResult.packs);
    const samplePack = ChapterUnitPackSchema.parse(
      JSON.parse(readFileSync(join(outDir, "packs", packFiles[0]), "utf8")),
    );
    expect(Object.keys(samplePack.units).length).toBeGreaterThan(0);

    AnchorIndexSchema.parse(
      JSON.parse(readFileSync(join(outDir, "anchors.json"), "utf8")),
    );

    // Check Git revision history in unit meta shard
    const shardPath = join(outDir, "meta", `${x0UnitId.slice(0, 2)}.json`);
    expect(existsSync(shardPath)).toBe(true);
    const shard = UnitMetaShardSchema.parse(JSON.parse(readFileSync(shardPath, "utf8")));
    const x0Meta = shard[x0UnitId];
    expect(x0Meta).toBeDefined();
    expect(x0Meta.upstream_history.map((u) => u.sha)).toEqual([sha2]);
    expect(x0Meta.revisions.length).toBeGreaterThanOrEqual(2);
    expect(x0Meta.revisions[0].status).toBe("approved");
    expect(x0Meta.revisions[0].zh).toBe("寄存器 `x0` 硬连线为常数 0。");

    const updatedX0ShardPath = join(outDir, "meta", `${updatedX0Id.slice(0, 2)}.json`);
    expect(existsSync(updatedX0ShardPath)).toBe(true);
    const updatedX0Shard = UnitMetaShardSchema.parse(
      JSON.parse(readFileSync(updatedX0ShardPath, "utf8")),
    );
    expect(updatedX0Shard[updatedX0Id]).toBeDefined();
    expect(updatedX0Shard[updatedX0Id].prev_unit_id).toBe(x0UnitId);
    expect(updatedX0Shard[updatedX0Id].upstream_history.map((u) => u.sha)).toEqual([sha3, sha2]);

    const searchRaw = JSON.parse(readFileSync(join(outDir, "search.json"), "utf8")) as Array<
      Record<string, unknown>
    >;
    expect(searchRaw.length).toBeGreaterThan(0);
    const parsedSearch = searchRaw.map((entry) => SearchEntrySchema.parse(entry));
    for (const entry of parsedSearch) {
      expect(entry.kind).toBeDefined();
      expect(entry.chapter_title_zh).toBeDefined();
      expect(entry.en).not.toContain("|===");
      expect(entry.en).not.toContain("[source");
      expect(entry.en).not.toContain("----");
      expect(entry.en).not.toContain("==");
      expect(entry.en).not.toContain("`");
      if (entry.zh) {
        expect(entry.zh).not.toContain("|===");
        expect(entry.zh).not.toContain("[source");
        expect(entry.zh).not.toContain("----");
        expect(entry.zh).not.toContain("`");
      }
    }
    const addPara = parsedSearch.find((e) => e.en.includes("adds two registers"));
    expect(addPara).toBeDefined();
    expect(addPara!.symbols).toEqual(["ADD", "rd"]);
    const regPara = parsedSearch.find((e) => e.en.includes("general-purpose registers"));
    expect(regPara?.symbols).toEqual(["x0", "x31"]);
    const codeEntry = parsedSearch.find((e) => e.kind === "code");
    expect(codeEntry?.en).toBe("add x1, x2, x3");
    const tableEntry = parsedSearch.find((e) => e.kind === "table");
    expect(tableEntry?.en).toBe("Field · Bits — rd · 11:7");
    expect(tableEntry?.symbols).toEqual(["rd"]);

    // Verify non-translatable UnitToml omits status and zh
    const firstPackUnit = Object.values(samplePack.units).find((u) => !u.translatable);
    if (firstPackUnit) {
      const diskUnit = parseUnitToml(
        readFileSync(join(dataDir, unitRelPath(firstPackUnit.unit_id)), "utf8"),
      );
      expect(diskUnit.translatable).toBe(false);
      expect("status" in diskUnit).toBe(false);
      expect("zh" in diskUnit).toBe(false);
    }
  });

  it("supports maxMinutes checkpointing with [skip ci] and resumes remaining translations across runs", async () => {
    const upstreamDir = makeTempDir("riscv-upstream-resume-");
    const dataDir = makeTempDir("riscv-data-resume-");

    initGitRepo(upstreamDir);
    mkdirSync(join(upstreamDir, "src"), { recursive: true });
    writeFileSync(
      join(upstreamDir, "src", "riscv-unprivileged.adoc"),
      [
        "= RISC-V Unprivileged",
        "",
        "== Chapter One",
        "",
        "First paragraph with `x1`.",
        "",
        "Second paragraph with `x2`.",
      ].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "feat: initial"], upstreamDir);

    initGitRepo(dataDir);
    mkdirSync(join(dataDir, "manifests"), { recursive: true });
    writeFileSync(join(dataDir, "GLOSSARY.md"), "# Glossary\n", "utf8");
    writeFileSync(
      join(dataDir, "manifests", "index.json"),
      JSON.stringify({
        upstream_repo: upstreamDir,
        baseline_cutoff: "2023-06-01",
        last_synced_sha: null,
        known_tags: {},
        commits: [],
      }),
      "utf8",
    );
    git(["add", "-A"], dataDir);
    git(["commit", "-m", "chore: init"], dataDir);

    // Run 1: immediate time budget expiry -> checkpoints snapshots with [skip ci] and hasRemaining: true
    const run1 = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      maxMinutes: 0,
      provider: "mock",
    });
    expect(run1.processedCommits).toBe(1);
    expect(run1.translatedUnits).toBe(0);
    expect(run1.hasRemaining).toBe(true);
    expect(git(["log", "-1", "--pretty=%s"], dataDir)).toContain("[skip ci]");

    // Run 2: resumes remaining translations with 0 new commits and commits without [skip ci]
    const run2 = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "mock",
    });
    expect(run2.processedCommits).toBe(0);
    expect(run2.translatedUnits).toBeGreaterThan(0);
    expect(run2.hasRemaining).toBe(false);
    expect(git(["log", "-1", "--pretty=%s"], dataDir)).not.toContain("[skip ci]");

    // Verify CLI subcommands with INIT_CWD relative paths and GITHUB_OUTPUT
    const parentWorkDir = makeTempDir("riscv-cli-cwd-");
    const relDataDir = join(parentWorkDir, "data-copy");
    const relOutDir = "site-out";
    const ghOutFile = join(parentWorkDir, "github_output.txt");
    writeFileSync(ghOutFile, "", "utf8");
    Bun.spawnSync(["cp", "-r", dataDir, relDataDir]);

    const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
    const syncCli = Bun.spawnSync(
      ["bun", "run", cliPath, "sync", "--upstream", upstreamDir, "--data", "data-copy", "--provider", "mock"],
      {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, INIT_CWD: parentWorkDir, GITHUB_OUTPUT: ghOutFile },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(syncCli.exitCode).toBe(0);
    expect(readFileSync(ghOutFile, "utf8")).toContain("has_remaining=false");

    const valCli = Bun.spawnSync(["bun", "run", cliPath, "validate-data", "--data", "data-copy"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, INIT_CWD: parentWorkDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(valCli.exitCode).toBe(0);

    const buildCli = Bun.spawnSync(
      [
        "bun",
        "run",
        cliPath,
        "build-site",
        "--upstream",
        upstreamDir,
        "--data",
        "data-copy",
        "--out",
        relOutDir,
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, INIT_CWD: parentWorkDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(buildCli.exitCode).toBe(0);
    expect(existsSync(join(parentWorkDir, relOutDir, "index.json"))).toBe(true);
  });

  it("preserves prev_unit_id on units modified in earlier commits when HEAD is a subsequent commit", async () => {
    const upstreamDir = makeTempDir("riscv-upstream-3commit-");
    const dataDir = makeTempDir("riscv-data-3commit-");
    const outDir = makeTempDir("riscv-out-3commit-");

    initGitRepo(upstreamDir);
    mkdirSync(join(upstreamDir, "src"), { recursive: true });

    const c1 = [
      "= RISC-V Unprivileged",
      "",
      "== RV32I",
      "",
      "The ADDI instruction adds the sign-extended 12-bit immediate to register rs1 and places the result in rd.",
      "",
      "Obsolete paragraph that will be removed in commit 3.",
    ].join("\n");
    writeFileSync(join(upstreamDir, "src", "riscv-unprivileged.adoc"), c1, "utf8");
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "commit 1"], upstreamDir);

    const c2 = [
      "= RISC-V Unprivileged",
      "",
      "== RV32I",
      "",
      "The ADDI instruction adds the sign-extended 12-bit immediate to register rs1 and writes the lower XLEN bits to rd.",
      "",
      "Obsolete paragraph that will be removed in commit 3.",
    ].join("\n");
    writeFileSync(join(upstreamDir, "src", "riscv-unprivileged.adoc"), c2, "utf8");
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "commit 2: edit ADDI"], upstreamDir);

    const c3 = [
      "= RISC-V Unprivileged",
      "",
      "== RV32I",
      "",
      "The ADDI instruction adds the sign-extended 12-bit immediate to register rs1 and writes the lower XLEN bits to rd.",
      "",
      "== HINT Instructions",
      "",
      "HINT instructions execute as no-ops.",
    ].join("\n");
    writeFileSync(join(upstreamDir, "src", "riscv-unprivileged.adoc"), c3, "utf8");
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "commit 3: add HINT section"], upstreamDir);

    initGitRepo(dataDir);
    mkdirSync(join(dataDir, "manifests"), { recursive: true });
    writeFileSync(join(dataDir, "GLOSSARY.md"), "# Glossary\n", "utf8");
    writeFileSync(
      join(dataDir, "manifests", "index.json"),
      JSON.stringify({
        upstream_repo: upstreamDir,
        baseline_cutoff: "2023-06-01",
        last_synced_sha: null,
        known_tags: {},
        commits: [],
      }),
      "utf8",
    );
    git(["add", "-A"], dataDir);
    git(["commit", "-m", "chore: init"], dataDir);

    const res = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "mock",
    });
    expect(res.processedCommits).toBe(3);
    expect(res.hasRemaining).toBe(false);

    let addiV1Id = "";
    let addiV2Id = "";
    const unitsDir = join(dataDir, "units");
    for (const prefix of readdirSync(unitsDir)) {
      for (const file of readdirSync(join(unitsDir, prefix))) {
        const parsed = parseUnitToml(readFileSync(join(unitsDir, prefix, file), "utf8"));
        if (parsed.en.includes("places the result in rd")) {
          addiV1Id = parsed.unit_id;
        } else if (parsed.en.includes("writes the lower XLEN bits to rd")) {
          addiV2Id = parsed.unit_id;
        }
      }
    }

    expect(addiV1Id).toMatch(/^[0-9a-f]{32}$/);
    expect(addiV2Id).toMatch(/^[0-9a-f]{32}$/);

    await buildSiteData({ dataDir, outDir });
    const shard = UnitMetaShardSchema.parse(
      JSON.parse(readFileSync(join(outDir, "meta", `${addiV2Id.slice(0, 2)}.json`), "utf8")),
    );
    expect(shard[addiV2Id].prev_unit_id).toBe(addiV1Id);
    expect(shard[addiV2Id].upstream_history.map((u) => u.title)).toEqual([
      "commit 2: edit ADDI",
      "commit 1",
    ]);
  });

  it("syncs upstream commits referencing ../docs-resources/global-config.adoc without submodule present", async () => {
    const upstreamDir = makeTempDir("riscv-upstream-globalcfg-");
    const dataDir = makeTempDir("riscv-data-globalcfg-");
    const outDir = makeTempDir("riscv-site-globalcfg-");

    initGitRepo(upstreamDir);
    mkdirSync(join(upstreamDir, "src"), { recursive: true });
    writeFileSync(
      join(upstreamDir, "src", "riscv-unprivileged.adoc"),
      [
        "[[header]]",
        ":description: Unprivileged ISA",
        "include::../docs-resources/global-config.adoc[]",
        ":doctype: book",
        "",
        "= Volume I",
        "",
        "== RV32I Base Integer Instruction Set",
        "",
        "RV32I defines 32 registers `x0` through `x31`.",
      ].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "feat: manual with global-config include"], upstreamDir);

    initGitRepo(dataDir);
    mkdirSync(join(dataDir, "manifests"), { recursive: true });
    writeFileSync(join(dataDir, "GLOSSARY.md"), "# Glossary\n", "utf8");
    writeFileSync(
      join(dataDir, "manifests", "index.json"),
      JSON.stringify({
        upstream_repo: upstreamDir,
        baseline_cutoff: "2023-06-01",
        last_synced_sha: null,
        known_tags: {},
        commits: [],
      }),
      "utf8",
    );
    git(["add", "-A"], dataDir);
    git(["commit", "-m", "chore: init"], dataDir);

    const syncRes = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "mock",
    });
    expect(syncRes.processedCommits).toBe(1);
    expect(syncRes.translatedUnits).toBe(3);
    expect(syncRes.hasRemaining).toBe(false);

    const unitsDir = join(dataDir, "units");
    for (const prefix of readdirSync(unitsDir)) {
      for (const file of readdirSync(join(unitsDir, prefix))) {
        const parsed = parseUnitToml(readFileSync(join(unitsDir, prefix, file), "utf8"));
        expect(parsed.en).not.toContain("Unresolved directive");
      }
    }

    const validation = await validateDataRepo(dataDir);
    expect(validation.ok).toBe(true);
    const buildRes = await buildSiteData({ dataDir, outDir });
    expect(buildRes.snapshots).toBe(1);
    expect(buildRes.units).toBe(3);
  });

  it("commits once per multi-batch sync and checkpoints mid-run LLM failure in finally with [skip ci]", async () => {
    const upstreamDir = makeTempDir("riscv-upstream-single-commit-");
    const dataDir = makeTempDir("riscv-data-single-commit-");

    initGitRepo(upstreamDir);
    mkdirSync(join(upstreamDir, "src"), { recursive: true });
    writeFileSync(
      join(upstreamDir, "src", "riscv-unprivileged.adoc"),
      [
        "= RISC-V Unprivileged",
        "",
        "== RV32I",
        "",
        "Paragraph one describes `x1`.",
        "",
        "Paragraph two describes `x2`.",
        "",
        "== RV64I",
        "",
        "Paragraph three describes `x3`.",
      ].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "feat: two chapters (five translatable blocks)"], upstreamDir);

    initGitRepo(dataDir);
    mkdirSync(join(dataDir, "manifests"), { recursive: true });
    writeFileSync(join(dataDir, "GLOSSARY.md"), "# Glossary\n", "utf8");
    writeFileSync(
      join(dataDir, "manifests", "index.json"),
      JSON.stringify({
        upstream_repo: upstreamDir,
        baseline_cutoff: "2023-06-01",
        last_synced_sha: null,
        known_tags: {},
        commits: [],
      }),
      "utf8",
    );
    git(["add", "-A"], dataDir);
    git(["commit", "-m", "chore: init"], dataDir);
    const initialCommitCount = Number(git(["rev-list", "--count", "HEAD"], dataDir));

    // 1. Complete multi-batch sync (2 chapters -> 2 chapter batches) must make only 1 git commit
    const fullSync = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "mock",
    });
    expect(fullSync.translatedUnits).toBe(6);
    expect(fullSync.hasRemaining).toBe(false);
    expect(Number(git(["rev-list", "--count", "HEAD"], dataDir))).toBe(initialCommitCount + 1);
    expect(git(["log", "-1", "--pretty=%s"], dataDir)).not.toContain("[skip ci]");

    // 2. Append a commit adding 3 new chapters (6 new translatable units); fail on batch 2 (Zifencei) and continue to batch 3 (Zawrs Wait)
    writeFileSync(
      join(upstreamDir, "src", "riscv-unprivileged.adoc"),
      [
        "= RISC-V Unprivileged",
        "",
        "== RV32I",
        "",
        "Paragraph one describes `x1`.",
        "",
        "Paragraph two describes `x2`.",
        "",
        "== RV64I",
        "",
        "Paragraph three describes `x3`.",
        "",
        "== Zicsr",
        "",
        "Paragraph four describes `x4`.",
        "",
        "== Zifencei",
        "",
        "Paragraph five describes `x5`.",
        "",
        "== Zawrs Wait",
        "",
        "Paragraph six describes `x6` waiting on reservation sets.",
      ].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "feat: add three more chapters"], upstreamDir);

    let callCount = 0;
    setGenerateObjectForTest((async (opts: { prompt: string }) => {
      callCount++;
      if (callCount === 2) {
        throw new Error("simulated API outage");
      }
      const matches = [
        ...opts.prompt.matchAll(/<unit id="([0-9a-f]{32})" kind="[^"]+">\n([\s\S]*?)\n<\/unit>/g),
      ];
      if (matches.length === 0) throw new Error(`unexpected prompt: ${opts.prompt}`);
      return {
        object: {
          translations: matches.map((m) => ({ unit_id: m[1], zh: `[ZH] ${m[2]}` })),
        },
      } as never;
    }) as never);

    const loggedErrors: string[] = [];
    const beforeFailCount = Number(git(["rev-list", "--count", "HEAD"], dataDir));
    const bestEffort = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "google",
      log: (msg) => loggedErrors.push(msg),
    });
    expect(bestEffort).toEqual({
      processedCommits: 1,
      translatedUnits: 4,
      hasRemaining: true,
      failedPages: 1,
    });
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0]).toContain("Zifencei");
    expect(loggedErrors[0]).toContain("simulated API outage");

    // Progress from Zicsr + Zawrs Wait was checkpoint-committed in finally with [skip ci]
    expect(Number(git(["rev-list", "--count", "HEAD"], dataDir))).toBe(beforeFailCount + 1);
    expect(git(["log", "-1", "--pretty=%s"], dataDir)).toContain("[skip ci]");

    // Resuming translates only the remaining 2 units in Zifencei
    setGenerateObjectForTest(undefined);
    const resume = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "mock",
    });
    expect(resume).toEqual({
      processedCommits: 0,
      translatedUnits: 2,
      hasRemaining: false,
    });
    expect(git(["log", "-1", "--pretty=%s"], dataDir)).not.toContain("[skip ci]");
  });

  it("skips non-spec --no-ff merge commits and processes spec-touching --no-ff merges", async () => {
    const upstreamDir = makeTempDir("riscv-upstream-merges-");
    const dataDir = makeTempDir("riscv-data-merges-");

    initGitRepo(upstreamDir);
    mkdirSync(join(upstreamDir, "src"), { recursive: true });
    writeFileSync(
      join(upstreamDir, "src", "riscv-unprivileged.adoc"),
      ["= RISC-V Unprivileged", "", "== Chapter One", "", "Initial text with `x1`."].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "feat: initial"], upstreamDir);

    // Non-spec merge commit (Makefile only)
    git(["checkout", "-b", "ci-only"], upstreamDir);
    writeFileSync(join(upstreamDir, "Makefile"), "all:\n\techo ok\n", "utf8");
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "ci: add Makefile"], upstreamDir);
    git(["checkout", "main"], upstreamDir);
    git(["merge", "--no-ff", "-m", "Merge pull request #1 (ci only)", "ci-only"], upstreamDir);

    // Spec-touching merge commit (.adoc change)
    git(["checkout", "-b", "spec-pr"], upstreamDir);
    writeFileSync(
      join(upstreamDir, "src", "riscv-unprivileged.adoc"),
      [
        "= RISC-V Unprivileged",
        "",
        "== Chapter One",
        "",
        "Initial text with `x1`.",
        "",
        "Spec PR text with `x2`.",
      ].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "docs: add spec PR text"], upstreamDir);
    git(["checkout", "main"], upstreamDir);
    const mergeMsg = "Merge pull request #2 (spec update)";
    git(["merge", "--no-ff", "-m", mergeMsg, "spec-pr"], upstreamDir);

    initGitRepo(dataDir);
    mkdirSync(join(dataDir, "manifests"), { recursive: true });
    writeFileSync(join(dataDir, "GLOSSARY.md"), "# Glossary\n", "utf8");
    writeFileSync(
      join(dataDir, "manifests", "index.json"),
      JSON.stringify({
        upstream_repo: upstreamDir,
        baseline_cutoff: "2023-06-01",
        last_synced_sha: null,
        known_tags: {},
        commits: [],
      }),
      "utf8",
    );
    git(["add", "-A"], dataDir);
    git(["commit", "-m", "chore: init"], dataDir);

    const res = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "mock",
    });

    // Only initial commit + spec merge commit should be processed; Makefile merge commit skipped
    expect(res.processedCommits).toBe(2);
    expect(res.hasRemaining).toBe(false);
    const idx = ManifestIndexSchema.parse(
      JSON.parse(readFileSync(join(dataDir, "manifests", "index.json"), "utf8")),
    );
    expect(idx.commits.map((c) => c.title)).toEqual(["feat: initial", mergeMsg]);
  });

  it("extractGitRevisions reads committed HEAD for dirty working-tree files and shared renderCache matches cold builds", async () => {
    const upstreamDir = makeTempDir("riscv-upstream-dirty-");
    const dataDir = makeTempDir("riscv-data-dirty-");
    const outCold = makeTempDir("riscv-site-cold-");
    const outWarm = makeTempDir("riscv-site-warm-");

    initGitRepo(upstreamDir);
    mkdirSync(join(upstreamDir, "src"), { recursive: true });
    writeFileSync(
      join(upstreamDir, "src", "riscv-unprivileged.adoc"),
      ["= RISC-V Unprivileged", "", "== Chapter One", "", "Register `x0` is zero."].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "feat: initial"], upstreamDir);

    initGitRepo(dataDir);
    mkdirSync(join(dataDir, "manifests"), { recursive: true });
    writeFileSync(join(dataDir, "GLOSSARY.md"), "# Glossary\n", "utf8");
    writeFileSync(
      join(dataDir, "manifests", "index.json"),
      JSON.stringify({
        upstream_repo: upstreamDir,
        baseline_cutoff: "2023-06-01",
        last_synced_sha: null,
        known_tags: {},
        commits: [],
      }),
      "utf8",
    );
    git(["add", "-A"], dataDir);
    git(["commit", "-m", "chore: init"], dataDir);

    await runSync({ upstreamUrlOrPath: upstreamDir, dataDir, provider: "mock" });

    // Commit an approved human revision so unit has 2 git commits
    let targetUnitId = "";
    const unitsDir = join(dataDir, "units");
    for (const prefix of readdirSync(unitsDir)) {
      for (const file of readdirSync(join(unitsDir, prefix))) {
        const u = parseUnitToml(readFileSync(join(unitsDir, prefix, file), "utf8"));
        if (u.translatable && u.en.includes("Register `x0` is zero.")) {
          targetUnitId = u.unit_id;
          writeFileSync(
            join(unitsDir, prefix, file),
            serializeUnitToml({ ...u, status: "approved", zh: "已提交的正式译文 `x0`。" }),
            "utf8",
          );
        }
      }
    }
    expect(targetUnitId).toMatch(/^[0-9a-f]{32}$/);
    git(["add", "-A"], dataDir);
    git(["commit", "-m", "review: approve x0"], dataDir);

    // Dirty the working tree without committing
    const dirtyPath = join(dataDir, unitRelPath(targetUnitId));
    const committedUnit = parseUnitToml(readFileSync(dirtyPath, "utf8"));
    if (!committedUnit.translatable) {
      throw new Error("expected translatable unit");
    }
    writeFileSync(
      dirtyPath,
      serializeUnitToml({ ...committedUnit, status: "machine", zh: "UNCOMMITTED DRAFT `x0`" }),
      "utf8",
    );

    const coldRes = await buildSiteData({ dataDir, outDir: outCold });
    const renderCache = new Map<string, string>();
    // Populate cache on first warm run, reuse on second warm run
    await buildSiteData({ dataDir, outDir: outWarm, renderCache });
    expect(renderCache.size).toBeGreaterThan(0);
    rmSync(outWarm, { recursive: true, force: true });
    mkdirSync(outWarm, { recursive: true });
    const warmRes = await buildSiteData({ dataDir, outDir: outWarm, renderCache });

    expect(warmRes).toEqual(coldRes);

    // Verify revision history reports committed HEAD, NOT the uncommitted draft
    const coldShard = UnitMetaShardSchema.parse(
      JSON.parse(readFileSync(join(outCold, "meta", `${targetUnitId.slice(0, 2)}.json`), "utf8")),
    );
    expect(coldShard[targetUnitId].revisions).toHaveLength(2);
    expect(coldShard[targetUnitId].revisions[0].zh).toBe("已提交的正式译文 `x0`。");
    expect(coldShard[targetUnitId].revisions[0].status).toBe("approved");
    expect(coldShard[targetUnitId].revisions[1].zh).toContain("[ZH]");

    // Verify cold vs cached output equivalence across trees, chapters, packs, meta shards, and search.json
    for (const dirName of ["trees", "chapters", "packs", "meta"]) {
      const coldFiles = readdirSync(join(outCold, dirName)).sort();
      const warmFiles = readdirSync(join(outWarm, dirName)).sort();
      expect(warmFiles).toEqual(coldFiles);
      for (const f of coldFiles) {
        expect(readFileSync(join(outWarm, dirName, f), "utf8")).toBe(
          readFileSync(join(outCold, dirName, f), "utf8"),
        );
      }
    }
    expect(readFileSync(join(outWarm, "anchors.json"), "utf8")).toBe(
      readFileSync(join(outCold, "anchors.json"), "utf8"),
    );
    expect(readFileSync(join(outWarm, "search.json"), "utf8")).toBe(
      readFileSync(join(outCold, "search.json"), "utf8"),
    );
  });

  it("sorts pages across volumes by total untranslated character count ascending on initial and incremental syncs", async () => {
    const upstreamDir = makeTempDir("riscv-upstream-sort-");
    const dataDir = makeTempDir("riscv-data-sort-");

    initGitRepo(upstreamDir);
    mkdirSync(join(upstreamDir, "src"), { recursive: true });

    const bigTableChapter = [
      "== Big Table Chapter",
      "",
      "|===",
      "| Field | Description",
      "| `opcode` | Major opcode bits 6:0 identifying the base instruction encoding group across RV32I and RV64I.",
      "| `rd` | Destination register index 11:7 selecting one of the general-purpose registers `x0` through `x31` for result writeback.",
      "|===",
      "",
      "Old note.",
    ].join("\n");

    const threeTinyParagraphs = [
      "== Three Tiny Paragraphs",
      "",
      "First short line.",
      "",
      "Second short line.",
      "",
      "Third short line.",
    ].join("\n");

    const tinyPrivNote = ["== Tiny Priv Note", "", "Brief note."].join("\n");

    writeFileSync(
      join(upstreamDir, "src", "riscv-unprivileged.adoc"),
      ["= RISC-V Unprivileged", "", bigTableChapter, "", threeTinyParagraphs].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(upstreamDir, "src", "riscv-privileged.adoc"),
      ["= RISC-V Privileged", "", tinyPrivNote].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "feat: chapters of varying untranslated sizes"], upstreamDir);

    initGitRepo(dataDir);
    mkdirSync(join(dataDir, "manifests"), { recursive: true });
    writeFileSync(join(dataDir, "GLOSSARY.md"), "# Glossary\n", "utf8");
    writeFileSync(
      join(dataDir, "manifests", "index.json"),
      JSON.stringify({
        upstream_repo: upstreamDir,
        baseline_cutoff: "2023-06-01",
        last_synced_sha: null,
        known_tags: {},
        commits: [],
      }),
      "utf8",
    );
    git(["add", "-A"], dataDir);
    git(["commit", "-m", "chore: init"], dataDir);

    const observedOrder: string[] = [];
    setGenerateObjectForTest(async (opts) => {
      const userPrompt = opts.messages[0].content;
      const headingMatch = matchPromptChapterHeading(userPrompt);
      if (!headingMatch) {
        throw new Error(`Missing chapter heading in prompt: ${userPrompt}`);
      }
      observedOrder.push(headingMatch[1]);
      const matches = [
        ...userPrompt.matchAll(/<unit id="([0-9a-f]{32})" kind="[^"]+">\n([\s\S]*?)\n<\/unit>/g),
      ];
      return {
        object: {
          translations: matches.map((m) => ({ unit_id: m[1], zh: `[ZH] ${m[2]}` })),
        },
      };
    });

    const initial = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "google",
    });
    expect(initial.hasRemaining).toBe(false);
    // Tiny Priv Note (~28 chars, priv) -> Three Tiny Paragraphs (~77 chars, 4 units) -> Big Table Chapter (~300 chars, 3 units)
    expect(observedOrder).toEqual([
      "Tiny Priv Note",
      "Three Tiny Paragraphs",
      "Big Table Chapter",
    ]);

    // Incremental sync: edit 1 short paragraph inside Big Table Chapter (~25 untranslated chars)
    // and add a brand-new medium chapter (~175 untranslated chars) before it in document order.
    const updatedBigTable = bigTableChapter.replace("Old note.", "New short line with `x1`.");
    const mediumNewExtension = [
      "== Medium New Extension",
      "",
      "This new extension chapter introduces additional instructions and rules covering `x5`, `x6`, and `x7` across more than one hundred characters of text.",
    ].join("\n");
    writeFileSync(
      join(upstreamDir, "src", "riscv-unprivileged.adoc"),
      [
        "= RISC-V Unprivileged",
        "",
        mediumNewExtension,
        "",
        updatedBigTable,
        "",
        threeTinyParagraphs,
      ].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "docs: edit big table note and add medium extension"], upstreamDir);

    observedOrder.length = 0;
    const incremental = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "google",
    });
    expect(incremental.processedCommits).toBe(1);
    expect(incremental.hasRemaining).toBe(false);
    // Big Table Chapter only has 1 short untranslated unit (~25 chars), so it runs before Medium New Extension
    expect(observedOrder).toEqual(["Big Table Chapter", "Medium New Extension"]);
  });

  it("skips re-attempting failed units across older snapshots while still translating remaining pages", async () => {
    const upstreamDir = makeTempDir("riscv-upstream-fail-dedup-");
    const dataDir = makeTempDir("riscv-data-fail-dedup-");

    initGitRepo(upstreamDir);
    mkdirSync(join(upstreamDir, "src"), { recursive: true });

    const failingChapter = [
      "== Failing Chapter",
      "",
      "This failing chapter body is repeated identically across commits with `x1`.",
    ].join("\n");
    const legacyChapter = [
      "== Legacy Chapter",
      "",
      "Obsolete chapter removed later with `x2` and extra context.",
    ].join("\n");
    const passingChapter = [
      "== Passing Chapter",
      "",
      "Short passing chapter `x3`.",
    ].join("\n");

    writeFileSync(
      join(upstreamDir, "src", "riscv-unprivileged.adoc"),
      ["= RISC-V Unprivileged", "", failingChapter, "", legacyChapter].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "feat: commit 1 with legacy and failing chapters"], upstreamDir);

    writeFileSync(
      join(upstreamDir, "src", "riscv-unprivileged.adoc"),
      ["= RISC-V Unprivileged", "", passingChapter, "", failingChapter].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "docs: replace legacy with passing chapter"], upstreamDir);

    initGitRepo(dataDir);
    mkdirSync(join(dataDir, "manifests"), { recursive: true });
    writeFileSync(join(dataDir, "GLOSSARY.md"), "# Glossary\n", "utf8");
    writeFileSync(
      join(dataDir, "manifests", "index.json"),
      JSON.stringify({
        upstream_repo: upstreamDir,
        baseline_cutoff: "2023-06-01",
        last_synced_sha: null,
        known_tags: {},
        commits: [],
      }),
      "utf8",
    );
    git(["add", "-A"], dataDir);
    git(["commit", "-m", "chore: init"], dataDir);

    let failingAttempts = 0;
    const succeededChapters: string[] = [];
    setGenerateObjectForTest(async (opts) => {
      const userPrompt = opts.messages[0].content;
      const headingMatch = matchPromptChapterHeading(userPrompt);
      const chapter = headingMatch?.[1] ?? "unknown";
      if (chapter === "Failing Chapter") {
        failingAttempts++;
        throw new Error("bad gateway on failing chapter");
      }
      succeededChapters.push(chapter);
      const matches = [
        ...userPrompt.matchAll(/<unit id="([0-9a-f]{32})" kind="[^"]+">\n([\s\S]*?)\n<\/unit>/g),
      ];
      return {
        object: {
          translations: matches.map((m) => ({ unit_id: m[1], zh: `[ZH] ${m[2]}` })),
        },
      };
    });

    const loggedErrors: string[] = [];
    const res = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "google",
      log: (msg) => loggedErrors.push(msg),
    });

    expect(failingAttempts).toBe(1);
    expect(succeededChapters).toEqual(["Passing Chapter", "Legacy Chapter"]);
    expect(res.processedCommits).toBe(2);
    expect(res.translatedUnits).toBe(4);
    expect(res.hasRemaining).toBe(true);
    expect(res.failedPages).toBe(1);
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0]).toContain("Failing Chapter");
    expect(loggedErrors[0]).toContain("bad gateway on failing chapter");
  });

  it("fails fast on first LLM error when failFast is true or CI=1, checkpoints progress, and resumes", async () => {
    const setupFailFastFixture = () => {
      const upstreamDir = makeTempDir("riscv-upstream-ff-");
      const dataDir = makeTempDir("riscv-data-ff-");

      initGitRepo(upstreamDir);
      mkdirSync(join(upstreamDir, "src"), { recursive: true });
      writeFileSync(
        join(upstreamDir, "src", "riscv-unprivileged.adoc"),
        [
          "= RISC-V Unprivileged",
          "",
          "== Zicsr",
          "",
          "Short text `x1`.",
          "",
          "== Zifencei",
          "",
          "Medium fence text `x2` that fails in this run.",
          "",
          "== Zawrs Wait",
          "",
          "Longer reservation wait text `x3` that should not even be attempted after fail-fast.",
        ].join("\n"),
        "utf8",
      );
      git(["add", "-A"], upstreamDir);
      git(["commit", "-m", "feat: three chapters"], upstreamDir);

      initGitRepo(dataDir);
      mkdirSync(join(dataDir, "manifests"), { recursive: true });
      writeFileSync(join(dataDir, "GLOSSARY.md"), "# Glossary\n", "utf8");
      writeFileSync(
        join(dataDir, "manifests", "index.json"),
        JSON.stringify({
          upstream_repo: upstreamDir,
          baseline_cutoff: "2023-06-01",
          last_synced_sha: null,
          known_tags: {},
          commits: [],
        }),
        "utf8",
      );
      git(["add", "-A"], dataDir);
      git(["commit", "-m", "chore: init"], dataDir);
      return { upstreamDir, dataDir };
    };

    const runWithFailureOnSecondCall = () => {
      let calls = 0;
      const attemptedChapters: string[] = [];
      setGenerateObjectForTest(async (opts) => {
        calls++;
        const userPrompt = opts.messages[0].content;
        const headingMatch = matchPromptChapterHeading(userPrompt);
        const chapter = headingMatch?.[1] ?? "unknown";
        attemptedChapters.push(chapter);
        if (calls === 2) {
          throw new Error("simulated fail-fast outage");
        }
        const matches = [
          ...userPrompt.matchAll(/<unit id="([0-9a-f]{32})" kind="[^"]+">\n([\s\S]*?)\n<\/unit>/g),
        ];
        return {
          object: {
            translations: matches.map((m) => ({ unit_id: m[1], zh: `[ZH] ${m[2]}` })),
          },
        };
      });
      return {
        getCalls: () => calls,
        attemptedChapters,
      };
    };

    // 1. Explicit failFast: true
    {
      const { upstreamDir, dataDir } = setupFailFastFixture();
      const tracker = runWithFailureOnSecondCall();
      const loggedErrors: string[] = [];
      const initialCount = Number(git(["rev-list", "--count", "HEAD"], dataDir));

      await expect(
        runSync({
          upstreamUrlOrPath: upstreamDir,
          dataDir,
          provider: "google",
          failFast: true,
          log: (msg) => loggedErrors.push(msg),
        }),
      ).rejects.toThrow(/Zifencei[\s\S]*simulated fail-fast outage/);

      // Stopped immediately on batch 2 (Zifencei) without calling batch 3 (Zawrs Wait)
      expect(tracker.getCalls()).toBe(2);
      expect(tracker.attemptedChapters).toEqual(["Zicsr", "Zifencei"]);
      expect(loggedErrors).toHaveLength(0);

      // Batch 1 progress was checkpointed with [skip ci]
      expect(Number(git(["rev-list", "--count", "HEAD"], dataDir))).toBe(initialCount + 1);
      expect(git(["log", "-1", "--pretty=%s"], dataDir)).toContain("[skip ci]");

      // Resume translates the remaining 2 chapters (5 units: Zifencei + Zawrs Wait + volume title)
      setGenerateObjectForTest(undefined);
      const resume = await runSync({
        upstreamUrlOrPath: upstreamDir,
        dataDir,
        provider: "mock",
        failFast: true,
      });
      expect(resume).toEqual({
        processedCommits: 0,
        translatedUnits: 5,
        hasRemaining: false,
      });
      expect(git(["log", "-1", "--pretty=%s"], dataDir)).not.toContain("[skip ci]");
    }

    // 2. Implicit CI=1 default (when failFast option is omitted)
    {
      const { upstreamDir, dataDir } = setupFailFastFixture();
      const tracker = runWithFailureOnSecondCall();
      const prevCi = process.env.CI;
      process.env.CI = "1";
      try {
        await expect(
          runSync({
            upstreamUrlOrPath: upstreamDir,
            dataDir,
            provider: "google",
          }),
        ).rejects.toThrow("simulated fail-fast outage");
      } finally {
        if (prevCi === undefined) delete process.env.CI;
        else process.env.CI = prevCi;
      }
      expect(tracker.getCalls()).toBe(2);
      expect(tracker.attemptedChapters).toEqual(["Zicsr", "Zifencei"]);
    }
  });

  it("schedules disjoint-unit chapters in parallel, deduplicates shared units across manuals, and runs zero LLM calls for subsets", async () => {
    const upstreamDir = makeTempDir("riscv-upstream-parallel-");
    const dataDir = makeTempDir("riscv-data-parallel-");

    initGitRepo(upstreamDir);
    mkdirSync(join(upstreamDir, "src"), { recursive: true });

    const sharedParagraph = "Shared paragraph using `x1`.";
    const sharedC = "Charlie paragraph with content.";
    const uniqueA = "Alpha.";
    const uniqueB = "Bravo paragraph with sufficient length to sort last.";

    writeFileSync(
      join(upstreamDir, "src", "riscv-unprivileged.adoc"),
      [
        "= RISC-V Unprivileged",
        "",
        "== Tiny",
        "",
        "Ok.",
        "",
        "== Unpriv A",
        "",
        sharedParagraph,
        "",
        uniqueA,
        "",
        "== Unpriv C",
        "",
        sharedC,
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(upstreamDir, "src", "riscv-privileged.adoc"),
      [
        "= RISC-V Privileged",
        "",
        "== Priv B",
        "",
        uniqueB,
        "",
        "== Priv D",
        "",
        "Placeholder.",
      ].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "feat: add parallel scheduling chapters"], upstreamDir);

    initGitRepo(dataDir);
    mkdirSync(join(dataDir, "manifests"), { recursive: true });
    writeFileSync(join(dataDir, "GLOSSARY.md"), "# Glossary\n- `x1` -> `x1`\n", "utf8");
    writeFileSync(
      join(dataDir, "manifests", "index.json"),
      JSON.stringify({
        upstream_repo: upstreamDir,
        baseline_cutoff: "2023-06-01",
        last_synced_sha: null,
        known_tags: {},
        commits: [],
      }),
      "utf8",
    );
    git(["add", "-A"], dataDir);
    git(["commit", "-m", "chore: init"], dataDir);

    // Run 1 batch with mock so Tiny (shortest, 10 chars) is translated and snapshot manifest is written
    const seedRes = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "mock",
      maxBatches: 1,
    });
    expect(seedRes.hasRemaining).toBe(true);

    // Wire Priv B and Priv D in the snapshot manifest to reference shared unit_ids from Unpriv A and Unpriv C
    const indexJson = JSON.parse(readFileSync(join(dataDir, "manifests", "index.json"), "utf8")) as {
      last_synced_sha: string;
    };
    const headSha = indexJson.last_synced_sha;
    const hydratedHead = readHydratedSnapshot(dataDir, headSha);
    const allChapters = hydratedHead.volumes.flatMap((v) => v.chapters);
    const tinyChap = allChapters.find((c) => c.title_en === "Tiny")!;
    const unprivAChap = allChapters.find((c) => c.title_en === "Unpriv A")!;
    const unprivCChap = allChapters.find((c) => c.title_en === "Unpriv C")!;
    const privBChap = allChapters.find((c) => c.title_en === "Priv B")!;
    const privDChap = allChapters.find((c) => c.title_en === "Priv D")!;

    const seedHeadingId = tinyChap.title_unit_id!;
    const sharedUnitId = unprivAChap.sections[0].blocks[0].unit_id;
    const sharedCUnitId = unprivCChap.sections[0].blocks[0].unit_id;

    privBChap.sections[0].blocks.splice(1, 0, { unit_id: sharedUnitId });
    privDChap.title_unit_id = seedHeadingId;
    privDChap.sections[0].heading_unit_id = seedHeadingId;
    privDChap.sections[0].blocks = [
      { unit_id: sharedUnitId },
      { unit_id: sharedCUnitId },
    ];

    writeHydratedSnapshot(dataDir, hydratedHead);
    const referencedChaps = new Set<string>();
    for (const commit of JSON.parse(readFileSync(join(dataDir, "manifests", "index.json"), "utf8")).commits as Array<{ sha: string }>) {
      const s = JSON.parse(readFileSync(join(dataDir, "manifests", "snapshots", `${commit.sha}.json`), "utf8")) as {
        volumes: Array<{ chapters: Array<{ chap_hash: string }> }>;
      };
      for (const v of s.volumes) {
        for (const c of v.chapters) referencedChaps.add(`${c.chap_hash}.json`);
      }
    }
    for (const f of readdirSync(join(dataDir, "manifests", "chapters"))) {
      if (!referencedChaps.has(f)) {
        rmSync(join(dataDir, "manifests", "chapters", f));
      }
    }
    git(["add", "-A"], dataDir);
    git(["commit", "-m", "test: share unit_ids across chapters"], dataDir);

    let inFlight = 0;
    let maxConcurrent = 0;
    const attemptedChapters: string[] = [];
    const promptedUnits: string[] = [];
    const privBPrompts: string[] = [];

    // Barrier holds first two disjoint wave-1 chapters ("Unpriv C" & "Unpriv A") concurrently
    let releaseWave1: (() => void) | undefined;
    const wave1Ready = new Promise<void>((resolve) => {
      releaseWave1 = resolve;
    });
    let wave1Entered = 0;

    setGenerateObjectForTest(async (opts) => {
      const userPrompt = opts.messages[0].content;
      const headingMatch = matchPromptChapterHeading(userPrompt);
      const chapterName = headingMatch ? headingMatch[1] : "unknown";
      attemptedChapters.push(chapterName);

      inFlight++;
      if (inFlight > maxConcurrent) {
        maxConcurrent = inFlight;
      }

      try {
        if (chapterName === "Unpriv A" || chapterName === "Unpriv C") {
          wave1Entered++;
          if (wave1Entered === 2) {
            releaseWave1?.();
          }
          await wave1Ready;
        } else if (chapterName === "Priv B") {
          privBPrompts.push(userPrompt);
        }

        const matches = [
          ...userPrompt.matchAll(/<unit id="([0-9a-f]{32})" kind="[^"]+">\n([\s\S]*?)\n<\/unit>/g),
        ];
        for (const m of matches) {
          promptedUnits.push(m[2]);
        }
        return {
          object: {
            translations: matches.map((m) => ({ unit_id: m[1], zh: `[ZH] ${m[2]}` })),
          },
        };
      } finally {
        inFlight--;
      }
    });

    const res = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "google",
      llmConcurrency: 3,
    });

    expect(res.hasRemaining).toBe(false);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
    // Priv D needs 0 LLM calls because its heading came from Tiny and shared bodies finish in Wave 1
    expect(attemptedChapters.sort()).toEqual(["Priv B", "Unpriv A", "Unpriv C"]);
    // Shared paragraph is targeted in exactly one LLM prompt across the entire sync
    expect(promptedUnits.filter((en) => en === sharedParagraph)).toHaveLength(1);
    // Priv B receives [ZH] translation of sharedParagraph in read-only context while targeting only uniqueB + its heading
    expect(privBPrompts).toHaveLength(1);
    expect(privBPrompts[0]).toContain(`[ZH] ${sharedParagraph}`);
    const privBTargets = [
      ...privBPrompts[0].matchAll(/<unit id="([0-9a-f]{32})" kind="[^"]+">\n([\s\S]*?)\n<\/unit>/g),
    ].map((m) => m[2]);
    expect(privBTargets).not.toContain(sharedParagraph);
    expect(privBTargets).toContain(uniqueB);
    expect((await validateDataRepo(dataDir)).ok).toBe(true);
  });

  it("enforces maxBatches budget under parallel llmConcurrency and resumes remaining chapters cleanly", async () => {
    const upstreamDir = makeTempDir("riscv-upstream-parallel-budget-");
    const dataDir = makeTempDir("riscv-data-parallel-budget-");

    initGitRepo(upstreamDir);
    mkdirSync(join(upstreamDir, "src"), { recursive: true });
    writeFileSync(
      join(upstreamDir, "src", "riscv-unprivileged.adoc"),
      [
        "= RISC-V Unprivileged",
        "",
        "== Budget Chapter 1",
        "",
        "Unique text for chapter 1.",
        "",
        "== Budget Chapter 2",
        "",
        "Unique text for chapter 2.",
        "",
        "== Budget Chapter 3",
        "",
        "Unique text for chapter 3.",
        "",
        "== Budget Chapter 4",
        "",
        "Unique text for chapter 4.",
        "",
        "== Budget Chapter 5",
        "",
        "Unique text for chapter 5.",
      ].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "feat: 5 chapters for parallel budget test"], upstreamDir);

    initGitRepo(dataDir);
    mkdirSync(join(dataDir, "manifests"), { recursive: true });
    writeFileSync(join(dataDir, "GLOSSARY.md"), "# Glossary\n", "utf8");
    writeFileSync(
      join(dataDir, "manifests", "index.json"),
      JSON.stringify({
        upstream_repo: upstreamDir,
        baseline_cutoff: "2023-06-01",
        last_synced_sha: null,
        known_tags: {},
        commits: [],
      }),
      "utf8",
    );
    git(["add", "-A"], dataDir);
    git(["commit", "-m", "chore: init"], dataDir);

    let calls = 0;
    setGenerateObjectForTest(async (opts) => {
      calls++;
      const matches = [
        ...opts.messages[0].content.matchAll(/<unit id="([0-9a-f]{32})" kind="[^"]+">\n([\s\S]*?)\n<\/unit>/g),
      ];
      return {
        object: {
          translations: matches.map((m) => ({ unit_id: m[1], zh: `[ZH] ${m[2]}` })),
        },
      };
    });

    const firstRun = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "google",
      llmConcurrency: 4,
      maxBatches: 2,
    });
    expect(calls).toBe(2);
    expect(firstRun.hasRemaining).toBe(true);
    const lastSubject = Bun.spawnSync(["git", "log", "-1", "--pretty=%s"], {
      cwd: dataDir,
      stdout: "pipe",
    })
      .stdout.toString("utf8")
      .trim();
    expect(lastSubject).toContain("[skip ci]");

    calls = 0;
    const resumed = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "google",
      llmConcurrency: 4,
    });
    expect(calls).toBe(3);
    expect(resumed.hasRemaining).toBe(false);
  });

  it("aborts and settles in-flight sibling tasks on failFast failure under parallel llmConcurrency", async () => {
    const upstreamDir = makeTempDir("riscv-upstream-parallel-failfast-");
    const dataDir = makeTempDir("riscv-data-parallel-failfast-");

    initGitRepo(upstreamDir);
    mkdirSync(join(upstreamDir, "src"), { recursive: true });
    writeFileSync(
      join(upstreamDir, "src", "riscv-unprivileged.adoc"),
      [
        "= RISC-V Unprivileged",
        "",
        "== Parallel Sibling 1",
        "",
        "Sibling one unique text.",
        "",
        "== Parallel Boom 2",
        "",
        "Boom two unique text.",
        "",
        "== Parallel Sibling 3",
        "",
        "Sibling three unique text.",
      ].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "feat: 3 concurrent chapters for failFast test"], upstreamDir);

    initGitRepo(dataDir);
    mkdirSync(join(dataDir, "manifests"), { recursive: true });
    writeFileSync(join(dataDir, "GLOSSARY.md"), "# Glossary\n", "utf8");
    writeFileSync(
      join(dataDir, "manifests", "index.json"),
      JSON.stringify({
        upstream_repo: upstreamDir,
        baseline_cutoff: "2023-06-01",
        last_synced_sha: null,
        known_tags: {},
        commits: [],
      }),
      "utf8",
    );
    git(["add", "-A"], dataDir);
    git(["commit", "-m", "chore: init"], dataDir);

    let enteredAll = 0;
    let releaseAllEntered: (() => void) | undefined;
    const allEntered = new Promise<void>((resolve) => {
      releaseAllEntered = resolve;
    });
    const abortedChapters: string[] = [];
    const settledChapters: string[] = [];

    setGenerateObjectForTest(async (opts) => {
      const userPrompt = opts.messages[0].content;
      const headingMatch = matchPromptChapterHeading(userPrompt);
      const chapterName = headingMatch ? headingMatch[1] : "unknown";
      expect(opts.abortSignal).toBeDefined();

      enteredAll++;
      if (enteredAll === 3) {
        releaseAllEntered?.();
      }
      await allEntered;

      if (chapterName === "Parallel Boom 2") {
        settledChapters.push(chapterName);
        throw new Error("simulated concurrent outage");
      }

      try {
        if (!opts.abortSignal!.aborted) {
          await new Promise<void>((resolve) => {
            opts.abortSignal!.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        abortedChapters.push(chapterName);
        await new Promise((r) => setTimeout(r, 15));
        throw new Error("aborted sibling");
      } finally {
        settledChapters.push(chapterName);
      }
    });

    await expect(
      runSync({
        upstreamUrlOrPath: upstreamDir,
        dataDir,
        provider: "google",
        llmConcurrency: 3,
        failFast: true,
      }),
    ).rejects.toThrow("simulated concurrent outage");

    expect(abortedChapters.sort()).toEqual(["Parallel Sibling 1", "Parallel Sibling 3"]);
    expect(settledChapters.sort()).toEqual([
      "Parallel Boom 2",
      "Parallel Sibling 1",
      "Parallel Sibling 3",
    ]);
  });

  it("bundles all latest and historical referenced resources locally under content-addressed filenames", async () => {
    const upstreamDir = makeTempDir("riscv-upstream-res-strategy-");
    const dataDir = makeTempDir("riscv-data-res-strategy-");
    const outWithUpstream = makeTempDir("riscv-site-with-upstream-");
    const outDeployOnly = makeTempDir("riscv-site-deploy-only-");
    const outPlainDisk = makeTempDir("riscv-site-plain-disk-");

    const privimpsPngBytes = "HISTORICAL_PRIVIMPS_PNG_V1";
    const privimpsSvgBytes = '<svg xmlns="http://www.w3.org/2000/svg"><text>latest-svg</text></svg>\n';
    const diagramV1Bytes = "DIAGRAM_BYTES_V1";
    const diagramV2Bytes = "DIAGRAM_BYTES_V2_LATEST";
    const sharedBytes = "SHARED_UNCHANGED_BYTES";
    const upperPngBytes = "UPPER_PNG_BYTES";
    const unreferencedBytes = "UNREFERENCED_IMAGE_BYTES";

    initGitRepo(upstreamDir);
    mkdirSync(join(upstreamDir, "src/images/png"), { recursive: true });

    // Commit 1 (historical): PNG privimps, v1 of diagram.png, shared.png before directory move, and an unreferenced asset
    writeFileSync(join(upstreamDir, "src/images/png/privimps.png"), privimpsPngBytes, "utf8");
    writeFileSync(join(upstreamDir, "src/images/diagram.png"), diagramV1Bytes, "utf8");
    writeFileSync(join(upstreamDir, "src/images/shared.png"), sharedBytes, "utf8");
    writeFileSync(join(upstreamDir, "src/images/unreferenced.png"), unreferencedBytes, "utf8");
    writeFileSync(
      join(upstreamDir, "src/riscv-unprivileged.adoc"),
      [
        "= RISC-V Unprivileged",
        "",
        "== Diagrams",
        "",
        "image::diagram.png[]",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(upstreamDir, "src/riscv-privileged.adoc"),
      [
        "= RISC-V Privileged",
        "",
        "== Introduction",
        "",
        "[[privimps]]",
        ".Different implementation stacks.",
        "image::png/privimps.png[]",
        "",
        "image::shared.png[]",
        "",
      ].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "feat: historical snapshot with png"], upstreamDir);
    const sha1 = git(["rev-parse", "HEAD"], upstreamDir);

    // Commit 2 (latest): privimps.png deleted -> privimps.svg added; diagram.png updated in-place;
    // CASE_UPPER.PNG added; shared.png moved to src/priv/images/shared.png with identical bytes.
    rmSync(join(upstreamDir, "src/images/png/privimps.png"));
    mkdirSync(join(upstreamDir, "src/priv/images"), { recursive: true });
    writeFileSync(join(upstreamDir, "src/priv/images/privimps.svg"), privimpsSvgBytes, "utf8");
    writeFileSync(join(upstreamDir, "src/images/diagram.png"), diagramV2Bytes, "utf8");
    writeFileSync(join(upstreamDir, "src/images/CASE_UPPER.PNG"), upperPngBytes, "utf8");
    rmSync(join(upstreamDir, "src/images/shared.png"));
    writeFileSync(join(upstreamDir, "src/priv/images/shared.png"), sharedBytes, "utf8");
    writeFileSync(
      join(upstreamDir, "src/riscv-unprivileged.adoc"),
      [
        "= RISC-V Unprivileged",
        "",
        "== Diagrams",
        "",
        "image::diagram.png[]",
        "",
        "image::CASE_UPPER.PNG[]",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(upstreamDir, "src/riscv-privileged.adoc"),
      [
        "= RISC-V Privileged",
        "",
        "== Introduction",
        "",
        "[[privimps]]",
        ".Different implementation stacks.",
        "image::privimps.svg[]",
        "",
        "image::shared.png[]",
        "",
      ].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "feat: replace privimps png with svg and update diagram"], upstreamDir);
    const sha2 = git(["rev-parse", "HEAD"], upstreamDir);

    initGitRepo(dataDir);
    mkdirSync(join(dataDir, "manifests"), { recursive: true });
    writeFileSync(join(dataDir, "GLOSSARY.md"), "# Glossary\n", "utf8");
    writeFileSync(
      join(dataDir, "manifests", "index.json"),
      JSON.stringify({
        upstream_repo: upstreamDir,
        baseline_cutoff: "2023-06-01",
        last_synced_sha: null,
        known_tags: {},
        commits: [],
      }),
      "utf8",
    );
    git(["add", "-A"], dataDir);
    git(["commit", "-m", "chore: init"], dataDir);

    await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "mock",
    });

    const upstreamRepoUrl = "https://github.com/riscv/riscv-isa-manual";

    // No copied assets are written into dataDir; upstream mirror is the single source of truth
    expect(existsSync(join(dataDir, "assets"))).toBe(false);

    const bareMirrorDir = join(makeTempDir("riscv-res-mirror-"), "upstream.git");
    git(["clone", "--quiet", "--mirror", upstreamDir, bareMirrorDir], upstreamDir);

    // Build both WITH full upstream working tree and WITH cached bare mirror (CI job:deploy)
    await buildSiteData({
      dataDir,
      outDir: outWithUpstream,
      upstreamDir,
      upstreamRepoUrl,
    });
    await buildSiteData({
      dataDir,
      outDir: outDeployOnly,
      upstreamDir: bareMirrorDir,
      upstreamRepoUrl,
    });

    const privimpsPngAsset = contentAddressedAssetName(
      gitBlobSha1(privimpsPngBytes),
      "src/images/png/privimps.png",
    );
    const privimpsSvgAsset = contentAddressedAssetName(
      gitBlobSha1(privimpsSvgBytes),
      "src/priv/images/privimps.svg",
    );
    const diagramV1Asset = contentAddressedAssetName(
      gitBlobSha1(diagramV1Bytes),
      "src/images/diagram.png",
    );
    const diagramV2Asset = contentAddressedAssetName(
      gitBlobSha1(diagramV2Bytes),
      "src/images/diagram.png",
    );
    const sharedAsset = contentAddressedAssetName(
      gitBlobSha1(sharedBytes),
      "src/priv/images/shared.png",
    );
    const upperPngAsset = contentAddressedAssetName(
      gitBlobSha1(upperPngBytes),
      "src/images/CASE_UPPER.PNG",
    );
    const unreferencedAsset = contentAddressedAssetName(
      gitBlobSha1(unreferencedBytes),
      "src/images/unreferenced.png",
    );

    expect(upperPngAsset).toMatch(/^[0-9a-f]{16}\.png$/);
    expect(diagramV1Asset).not.toBe(diagramV2Asset);

    for (const outDir of [outWithUpstream, outDeployOnly]) {
      // Every referenced latest AND historical asset is materialized by blob SHA without path hierarchy
      expect(readFileSync(join(outDir, "assets", privimpsPngAsset), "utf8")).toBe(privimpsPngBytes);
      expect(readFileSync(join(outDir, "assets", privimpsSvgAsset), "utf8")).toBe(privimpsSvgBytes);
      expect(readFileSync(join(outDir, "assets", diagramV1Asset), "utf8")).toBe(diagramV1Bytes);
      expect(readFileSync(join(outDir, "assets", diagramV2Asset), "utf8")).toBe(diagramV2Bytes);
      expect(readFileSync(join(outDir, "assets", sharedAsset), "utf8")).toBe(sharedBytes);
      expect(readFileSync(join(outDir, "assets", upperPngAsset), "utf8")).toBe(upperPngBytes);
      expect(existsSync(join(outDir, "assets", unreferencedAsset))).toBe(false);
      expect(existsSync(join(outDir, "assets", "src"))).toBe(false);

      const siteIdx = JSON.parse(readFileSync(join(outDir, "index.json"), "utf8"));
      const snap1 = siteIdx.snapshots.find((s: { sha: string }) => s.sha === sha1);
      const snap2 = siteIdx.snapshots.find((s: { sha: string }) => s.sha === sha2);
      expect(snap1).toBeDefined();
      expect(snap2).toBeDefined();

      const readChapHtml = (snap: typeof snap1, volId: string) => {
        const tree = JSON.parse(readFileSync(join(outDir, "trees", `${snap.tree_hash}.json`), "utf8"));
        const vol = tree.volumes.find((v: { id: string }) => v.id === volId);
        const { struct_hash, pack_hash } = vol.chapters[0];
        const chapStruct = JSON.parse(
          readFileSync(join(outDir, "chapters", `${struct_hash}.json`), "utf8"),
        ) as {
          title_unit_id?: string;
          sections: Array<{
            heading_unit_id?: string;
            blocks: Array<string | { unit_id: string }>;
          }>;
          unit_overrides?: Record<string, { en_html: string }>;
        };
        const pack = JSON.parse(readFileSync(join(outDir, "packs", `${pack_hash}.json`), "utf8")) as {
          units: Record<string, { en_html: string }>;
        };
        const seen = new Set<string>();
        const htmls: string[] = [];
        const addUnit = (id?: string) => {
          if (!id || seen.has(id)) return;
          seen.add(id);
          const u = chapStruct.unit_overrides?.[id] ?? pack.units[id];
          if (u) htmls.push(u.en_html);
        };
        addUnit(chapStruct.title_unit_id);
        for (const sec of chapStruct.sections) {
          addUnit(sec.heading_unit_id);
          for (const b of sec.blocks) {
            addUnit(typeof b === "string" ? b : b.unit_id);
          }
        }
        return htmls.join("\n");
      };

      const snap1PrivHtml = readChapHtml(snap1, "priv");
      expect(snap1PrivHtml).toContain(`./data/assets/${privimpsPngAsset}`);
      expect(snap1PrivHtml).toContain(`./data/assets/${sharedAsset}`);
      expect(snap1PrivHtml).not.toContain(privimpsSvgAsset);
      expect(snap1PrivHtml).not.toContain("raw.githubusercontent.com");

      const snap1UnprivHtml = readChapHtml(snap1, "unpriv");
      expect(snap1UnprivHtml).toContain(`./data/assets/${diagramV1Asset}`);
      expect(snap1UnprivHtml).not.toContain("raw.githubusercontent.com");

      const snap2PrivHtml = readChapHtml(snap2, "priv");
      expect(snap2PrivHtml).toContain(`./data/assets/${privimpsSvgAsset}`);
      expect(snap2PrivHtml).toContain(`./data/assets/${sharedAsset}`);
      expect(snap2PrivHtml).not.toContain("raw.githubusercontent.com");

      const snap2UnprivHtml = readChapHtml(snap2, "unpriv");
      expect(snap2UnprivHtml).toContain(`./data/assets/${diagramV2Asset}`);
      expect(snap2UnprivHtml).toContain(`./data/assets/${upperPngAsset}`);
      expect(snap2UnprivHtml).not.toContain("raw.githubusercontent.com");
    }

    // Plain non-git working-tree copy computes the same blob SHA-1s and materializes latest assets identically
    const plainDir = makeTempDir("riscv-upstream-plain-copy-");
    mkdirSync(join(plainDir, "src/images"), { recursive: true });
    mkdirSync(join(plainDir, "src/priv/images"), { recursive: true });
    writeFileSync(join(plainDir, "src/priv/images/privimps.svg"), privimpsSvgBytes, "utf8");
    writeFileSync(join(plainDir, "src/images/diagram.png"), diagramV2Bytes, "utf8");
    writeFileSync(join(plainDir, "src/images/CASE_UPPER.PNG"), upperPngBytes, "utf8");
    writeFileSync(join(plainDir, "src/priv/images/shared.png"), sharedBytes, "utf8");
    writeFileSync(join(plainDir, "src/images/unreferenced.png"), unreferencedBytes, "utf8");

    await buildSiteData({
      dataDir,
      outDir: outPlainDisk,
      upstreamDir: plainDir,
      upstreamRepoUrl,
    });

    expect(readFileSync(join(outPlainDisk, "assets", privimpsSvgAsset), "utf8")).toBe(privimpsSvgBytes);
    expect(readFileSync(join(outPlainDisk, "assets", diagramV2Asset), "utf8")).toBe(diagramV2Bytes);
    expect(readFileSync(join(outPlainDisk, "assets", sharedAsset), "utf8")).toBe(sharedBytes);
    expect(readFileSync(join(outPlainDisk, "assets", upperPngAsset), "utf8")).toBe(upperPngBytes);
    expect(existsSync(join(outPlainDisk, "assets", unreferencedAsset))).toBe(false);
  });

  it("maps vYYYYMMDD release branches onto main --first-parent commits for initial and tag-only syncs", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "riscv-release-branch-"));
    tempDirs.push(tmp);

    const upstreamDir = join(tmp, "upstream");
    const dataDir = join(tmp, "data");
    mkdirSync(upstreamDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    initGitRepo(upstreamDir);
    mkdirSync(join(upstreamDir, "src"), { recursive: true });
    writeFileSync(
      join(upstreamDir, "src", "riscv-unprivileged.adoc"),
      ["= RISC-V Unprivileged", "", "include::intro.adoc[]"].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(upstreamDir, "src", "intro.adoc"),
      ["== Intro", "", "Initial spec."].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "feat: initial"], upstreamDir);
    const baseSha = git(["rev-parse", "HEAD"], upstreamDir).trim();
    git(["branch", "-M", "main"], upstreamDir);

    // Cut release branch v20260120, merge it into main via --no-ff, then add a release-only commit
    git(["checkout", "-b", "v20260120"], upstreamDir);
    writeFileSync(
      join(upstreamDir, "src", "intro.adoc"),
      ["== Intro", "", "Release 20260120 spec."].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "chore: prepare 20260120"], upstreamDir);

    git(["checkout", "main"], upstreamDir);
    git(["merge", "--no-ff", "v20260120", "-m", "Merge pull request #2589 from riscv/20260120"], upstreamDir);
    const mergeSha = git(["rev-parse", "HEAD"], upstreamDir).trim();

    // Advance v20260120 with a docs-site-only commit after the merge
    git(["checkout", "v20260120"], upstreamDir);
    writeFileSync(join(upstreamDir, "antora.yml"), "version: '20260120'\n", "utf8");
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "docs: antora nav fix"], upstreamDir);
    const releaseBranchHead = git(["rev-parse", "HEAD"], upstreamDir).trim();

    git(["checkout", "main"], upstreamDir);

    initGitRepo(dataDir);
    mkdirSync(join(dataDir, "manifests"), { recursive: true });
    writeFileSync(join(dataDir, "GLOSSARY.md"), "# Glossary\n", "utf8");
    writeFileSync(
      join(dataDir, "manifests", "index.json"),
      JSON.stringify({
        upstream_repo: upstreamDir,
        baseline_cutoff: "2023-06-01",
        last_synced_sha: null,
        known_tags: {},
        commits: [],
      }),
      "utf8",
    );
    git(["add", "-A"], dataDir);
    git(["commit", "-m", "chore: init"], dataDir);

    setGenerateObjectForTest(async (opts) => {
      const matches = [
        ...opts.messages[0].content.matchAll(/<unit id="([0-9a-f]{32})" kind="[^"]+">\n([\s\S]*?)\n<\/unit>/g),
      ];
      return {
        object: {
          translations: matches.map((m) => ({ unit_id: m[1], zh: `[ZH] ${m[2]}` })),
        },
      };
    });

    await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "google",
    });

    const index1 = JSON.parse(readFileSync(join(dataDir, "manifests", "index.json"), "utf8"));
    expect(index1.known_tags["20260120"]).toBe(releaseBranchHead);
    const mergeCommit = index1.commits.find((c: { sha: string }) => c.sha === mergeSha);
    expect(mergeCommit?.ratified_tag).toBe("20260120");
    expect(index1.commits.some((c: { sha: string }) => c.sha === releaseBranchHead)).toBe(false);

    // Now create a new release branch v20260201 off baseSha without touching main
    git(["checkout", "-b", "v20260201", baseSha], upstreamDir);
    writeFileSync(join(upstreamDir, "antora.yml"), "version: '20260201'\n", "utf8");
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "docs: release 20260201"], upstreamDir);
    const febBranchHead = git(["rev-parse", "HEAD"], upstreamDir).trim();
    git(["checkout", "main"], upstreamDir);

    await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "google",
    });

    const index2 = JSON.parse(readFileSync(join(dataDir, "manifests", "index.json"), "utf8"));
    expect(index2.known_tags["20260201"]).toBe(febBranchHead);
    const baseCommit = index2.commits.find((c: { sha: string }) => c.sha === baseSha);
    expect(baseCommit?.ratified_tag).toBe("20260201");
  });

  it("persists empty-zh stub TOMLs on partial sync, renders en_html with zh_html='', filters stub commits from revisions, and translates stubs on resume", async () => {
    const upstreamDir = makeTempDir("riscv-upstream-stubs-");
    const dataDir = makeTempDir("riscv-data-stubs-");
    const outPartial = makeTempDir("riscv-site-partial-");
    const outComplete = makeTempDir("riscv-site-complete-");

    initGitRepo(upstreamDir);
    mkdirSync(join(upstreamDir, "src"), { recursive: true });
    writeFileSync(
      join(upstreamDir, "src", "riscv-unprivileged.adoc"),
      [
        "= RISC-V Unprivileged",
        "",
        "== Alpha",
        "",
        "Short alpha `x1`.",
        "",
        "== Beta Untranslated Chapter",
        "",
        "This longer untranslated chapter explains `x2` behavior across the spec.",
        "",
        "=== Beta Subsection",
        "",
        "Subsection body describing `x3` fallback rendering.",
      ].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "feat: alpha and beta chapters"], upstreamDir);

    initGitRepo(dataDir);
    mkdirSync(join(dataDir, "manifests"), { recursive: true });
    writeFileSync(join(dataDir, "GLOSSARY.md"), "# Glossary\n", "utf8");
    writeFileSync(
      join(dataDir, "manifests", "index.json"),
      JSON.stringify({
        upstream_repo: upstreamDir,
        baseline_cutoff: "2023-06-01",
        last_synced_sha: null,
        known_tags: {},
        commits: [],
      }),
      "utf8",
    );
    git(["add", "-A"], dataDir);
    git(["commit", "-m", "chore: init"], dataDir);

    // 1. Sync only 1 batch (Alpha); Beta remains untranslated on this run
    const partial = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "mock",
      maxBatches: 1,
    });
    expect(partial.processedCommits).toBe(1);
    expect(partial.hasRemaining).toBe(true);

    // Untranslated units in Beta already have zh="" stub .toml files on disk
    let betaHeadingId = "";
    let betaBodyId = "";
    let betaSubBodyId = "";
    const unitsDir = join(dataDir, "units");
    for (const prefix of readdirSync(unitsDir)) {
      for (const file of readdirSync(join(unitsDir, prefix))) {
        const u = parseUnitToml(readFileSync(join(unitsDir, prefix, file), "utf8"));
        if (u.en.includes("Beta Untranslated Chapter")) {
          betaHeadingId = u.unit_id;
          expect(u.translatable).toBe(true);
          if (u.translatable) {
            expect(u.status).toBe("untranslated");
            expect(u.zh).toBe("");
          }
        } else if (u.en.includes("longer untranslated chapter")) {
          betaBodyId = u.unit_id;
          if (u.translatable) expect(u.zh).toBe("");
        } else if (u.en.includes("fallback rendering")) {
          betaSubBodyId = u.unit_id;
          if (u.translatable) expect(u.zh).toBe("");
        }
      }
    }
    expect(betaHeadingId).toMatch(/^[0-9a-f]{32}$/);
    expect(betaBodyId).toMatch(/^[0-9a-f]{32}$/);
    expect(betaSubBodyId).toMatch(/^[0-9a-f]{32}$/);
    expect((await validateDataRepo(dataDir)).ok).toBe(true);

    // 2. Building site on partial data renders en_html, omits empty zh_html, indexes en in search, and skips empty stubs in revisions
    await buildSiteData({ dataDir, outDir: outPartial });
    const partialIndex = SiteIndexSchema.parse(
      JSON.parse(readFileSync(join(outPartial, "index.json"), "utf8")),
    );
    const partialTree = SiteTreeSchema.parse(
      JSON.parse(
        readFileSync(join(outPartial, "trees", `${partialIndex.snapshots[0].tree_hash}.json`), "utf8"),
      ),
    );
    const betaChapEntry = partialTree.volumes[0].chapters.find(
      (c) => c.title_en === "Beta Untranslated Chapter",
    )!;
    expect(betaChapEntry).toBeDefined();
    expect(betaChapEntry.title_zh).toBe("Beta Untranslated Chapter");

    const partialBetaStruct = ChapterStructureSchema.parse(
      JSON.parse(readFileSync(join(outPartial, "chapters", `${betaChapEntry.struct_hash}.json`), "utf8")),
    );
    const partialBetaPack = ChapterUnitPackSchema.parse(
      JSON.parse(readFileSync(join(outPartial, "packs", `${betaChapEntry.pack_hash}.json`), "utf8")),
    );
    expect(partialBetaStruct.sections.map((s) => s.title_zh)).toEqual([
      "Beta Untranslated Chapter",
      "Beta Subsection",
    ]);
    expect(partialBetaPack.units[betaBodyId].en_html).toContain("longer untranslated chapter");
    expect(partialBetaPack.units[betaBodyId].zh_html).toBeUndefined();
    expect(partialBetaPack.units[betaSubBodyId].en_html).toContain("fallback rendering");
    expect(partialBetaPack.units[betaSubBodyId].zh_html).toBeUndefined();

    const partialSearch = JSON.parse(readFileSync(join(outPartial, "search.json"), "utf8")).map(
      (e: unknown) => SearchEntrySchema.parse(e),
    );
    const betaSearchEntry = partialSearch.find((e: { unit_id: string }) => e.unit_id === betaBodyId)!;
    expect(betaSearchEntry.en).toContain("longer untranslated chapter");
    expect(betaSearchEntry.zh).toBe("");

    const partialBetaShard = UnitMetaShardSchema.parse(
      JSON.parse(readFileSync(join(outPartial, "meta", `${betaBodyId.slice(0, 2)}.json`), "utf8")),
    );
    expect(partialBetaShard[betaBodyId].revisions).toEqual([]);

    // 3. Resume sync completes all remaining zh="" stub units with 0 upstream commits
    const resumed = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "mock",
    });
    expect(resumed.processedCommits).toBe(0);
    expect(resumed.translatedUnits).toBe(5); // vol title + Beta heading + Beta body + Beta subsection + sub body
    expect(resumed.hasRemaining).toBe(false);

    const updatedBetaUnit = parseUnitToml(
      readFileSync(join(dataDir, unitRelPath(betaBodyId)), "utf8"),
    );
    expect(updatedBetaUnit.translatable).toBe(true);
    if (updatedBetaUnit.translatable) {
      expect(updatedBetaUnit.zh).toContain("[ZH]");
    }

    await buildSiteData({ dataDir, outDir: outComplete });
    const completeBetaShard = UnitMetaShardSchema.parse(
      JSON.parse(readFileSync(join(outComplete, "meta", `${betaBodyId.slice(0, 2)}.json`), "utf8")),
    );
    // Only the translated commit appears in revisions; initial zh="" stub commit is excluded
    expect(completeBetaShard[betaBodyId].revisions).toHaveLength(1);
    expect(completeBetaShard[betaBodyId].revisions[0].zh).toContain("[ZH]");
  });

  it("enriches BibTeX citations from upstreamDir and bare upstream mirror without writing bibliography manifest to dataDir", async () => {
    const upstreamDir = makeTempDir("riscv-bib-up-");
    const dataDir = makeTempDir("riscv-bib-data-");
    const outWithUpstream = makeTempDir("riscv-bib-out-up-");
    const outWithMirror = makeTempDir("riscv-bib-out-mirror-");

    initGitRepo(upstreamDir);
    mkdirSync(join(upstreamDir, "src", "bib"), { recursive: true });
    writeFileSync(
      join(upstreamDir, "src", "bib", "refs.bib"),
      [
        "@techreport{waterman2014,",
        "  author = {Andrew Waterman and Yunsup Lee},",
        "  title = {{The RISC-V Instruction Set Manual}},",
        "  institution = {UC Berkeley},",
        "  year = {2014}",
        "}",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(upstreamDir, "src", "riscv-unprivileged.adoc"),
      [
        "= RISC-V Unprivileged Specification",
        "",
        "== Introduction",
        "",
        "See cite:[waterman2014] and cite:t[waterman2014] for details.",
      ].join("\n"),
      "utf8",
    );
    git(["add", "-A"], upstreamDir);
    git(["commit", "-m", "feat: add bibliography and citation"], upstreamDir);

    initGitRepo(dataDir);
    mkdirSync(join(dataDir, "manifests"), { recursive: true });
    writeFileSync(join(dataDir, "GLOSSARY.md"), "# Glossary\n", "utf8");
    writeFileSync(
      join(dataDir, "manifests", "index.json"),
      JSON.stringify({
        upstream_repo: upstreamDir,
        baseline_cutoff: "2020-01-01",
        last_synced_sha: null,
        known_tags: {},
        commits: [],
      }),
      "utf8",
    );
    git(["add", "-A"], dataDir);
    git(["commit", "-m", "chore: init data"], dataDir);

    const syncRes = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir,
      provider: "mock",
    });
    expect(syncRes.processedCommits).toBe(1);

    const bareMirrorDir = join(makeTempDir("riscv-bib-mirror-"), "upstream.git");
    git(["clone", "--quiet", "--mirror", upstreamDir, bareMirrorDir], upstreamDir);

    await buildSiteData({ dataDir, outDir: outWithUpstream, upstreamDir });
    await buildSiteData({ dataDir, outDir: outWithMirror, upstreamDir: bareMirrorDir });

    const readPackHtml = (outDir: string): string => {
      const idx = SiteIndexSchema.parse(JSON.parse(readFileSync(join(outDir, "index.json"), "utf8")));
      const tree = SiteTreeSchema.parse(
        JSON.parse(readFileSync(join(outDir, "trees", `${idx.snapshots[0].tree_hash}.json`), "utf8")),
      );
      const packHash = tree.volumes[0].chapters[0].pack_hash;
      const pack = ChapterUnitPackSchema.parse(
        JSON.parse(readFileSync(join(outDir, "packs", `${packHash}.json`), "utf8")),
      );
      return Object.values(pack.units)
        .map((u) => u.en_html)
        .join("\n");
    };

    const htmlWithUpstream = readPackHtml(outWithUpstream);
    const htmlWithMirror = readPackHtml(outWithMirror);
    expect(htmlWithMirror).toContain("data-cite-text=");
    expect(htmlWithMirror).toContain("Andrew Waterman and Yunsup Lee");
    expect(htmlWithMirror).toContain(">Andrew Waterman (2014)</a>");
    expect(htmlWithMirror).toBe(htmlWithUpstream);
  });
});
