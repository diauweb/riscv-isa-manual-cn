import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildSiteData } from "../src/build-site/index.ts";
import { runGitOrThrow } from "../src/git.ts";
import { runSync } from "../src/sync/index.ts";
import { validateDataRepo } from "../src/validate/index.ts";

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

function walkRelFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const ent of readdirSync(cur, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (ent.name === ".git") continue;
      const full = join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        out.push(relative(dir, full).split("\\").join("/"));
      }
    }
  }
  return out.sort();
}

function initRepoWithIdentity(dir: string): void {
  mkdirSync(dir, { recursive: true });
  runGitOrThrow(["init", "--quiet", "-b", "main"], dir);
  runGitOrThrow(["config", "user.name", "Test User"], dir);
  runGitOrThrow(["config", "user.email", "test@riscv-cn.invalid"], dir);
  runGitOrThrow(["config", "commit.gpgsign", "false"], dir);
  runGitOrThrow(["config", "tag.gpgsign", "false"], dir);
}

function initEmptyDataRepo(dataDir: string, upstreamDir: string): void {
  initRepoWithIdentity(dataDir);
  mkdirSync(join(dataDir, "manifests"), { recursive: true });
  writeFileSync(join(dataDir, "GLOSSARY.md"), "# Glossary\n- `hart` -> 硬件线程\n", "utf8");
  writeFileSync(
    join(dataDir, "manifests", "index.json"),
    `${JSON.stringify(
      {
        upstream_repo: upstreamDir,
        baseline_cutoff: "2023-06-01",
        last_synced_sha: null,
        known_tags: {},
        commits: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  runGitOrThrow(["add", "-A"], dataDir);
  runGitOrThrow(["commit", "--quiet", "-m", "chore: init data"], dataDir);
}

function buildMultiCommitUpstream(): string {
  const upstreamDir = makeTempDir("riscv-par-upstream-");
  initRepoWithIdentity(upstreamDir);
  mkdirSync(join(upstreamDir, "src"), { recursive: true });

  const makeUnpriv = (rev: number, opts: { extraPara?: string; dropSecondHalf?: boolean } = {}) => {
    const ch1Blocks: string[] = [
      "== RV32I Base Integer Instruction Set",
      ":chapter-status: Ratified",
      "",
      `RV32I defines 32 general-purpose registers \`x0\` through \`x31\` (revision ${rev}).`,
      "",
    ];
    for (let i = 1; i <= 20; i++) {
      const marker = i === 1 ? ` (rev ${rev})` : "";
      ch1Blocks.push(`Unprivileged rule ${i} specifies \`x${i % 32}\` with stem:[x_${i} + ${rev}].${marker}`, "");
    }
    ch1Blocks.push(
      "* Base integer item one",
      "* Base integer item two",
      "",
      "|===",
      "| Field | Bits",
      "| `opcode` | 6:0",
      `| \`rd\` rev ${rev} | 11:7`,
      "|===",
      "",
      "[source,asm]",
      "----",
      `addi x1, x0, ${rev}`,
      "----",
      "",
      "[stem]",
      "++++",
      `x = a + ${rev}`,
      "++++",
      "",
      "[wavedrom, , svg]",
      "....",
      `{"signal": [{"name": "clk", "wave": "p...."}]}`,
      "....",
      "",
      "[bytefield]",
      "----",
      `(draw-box "opcode" {:span 7})`,
      "----",
    );
    if (opts.extraPara) {
      ch1Blocks.push("", opts.extraPara);
    }

    const ch2Blocks: string[] = ["== Memory Model", ":chapter-status: Frozen", ""];
    const limit = opts.dropSecondHalf ? 8 : 16;
    for (let i = 1; i <= limit; i++) {
      ch2Blocks.push(`Memory ordering rule ${i} ensures a hart observes \`M${i}\` in program order.`, "");
    }

    return [
      "= RISC-V Unprivileged Specification",
      "",
      ...ch1Blocks,
      "",
      ...ch2Blocks,
    ].join("\n");
  };

  const makePriv = (rev: number, extraCount: number) => {
    const ch1Blocks: string[] = [
      "== Machine-Level ISA",
      ":chapter-status: Ratified",
      "",
      `Machine mode is mandatory for every hart in revision ${rev}.`,
      "",
    ];
    for (let i = 1; i <= 18 + extraCount; i++) {
      ch1Blocks.push(`CSR rule ${i} documents \`mstatus\` bit ${i} and offset 0x${(0x300 + i).toString(16)}.`, "");
    }

    const ch2Blocks: string[] = ["== Supervisor-Level ISA", ":chapter-status: Draft", ""];
    for (let i = 1; i <= 18; i++) {
      ch2Blocks.push(`Supervisor rule ${i} controls \`sstatus\` paging mode ${i}.`, "");
    }

    return ["= RISC-V Privileged Architecture", "", ...ch1Blocks, "", ...ch2Blocks].join("\n");
  };

  const commits: Array<{
    date: string;
    msg: string;
    tag?: string;
    unpriv: string;
    priv: string;
  }> = [
    {
      date: "2024-04-01T10:00:00+00:00",
      msg: "feat: initial manual v1",
      tag: "20240411",
      unpriv: makeUnpriv(1, { extraPara: "Legacy v1 paragraph deleted in later commits." }),
      priv: makePriv(1, 0),
    },
    {
      date: "2024-09-01T10:00:00+00:00",
      msg: "docs: update unpriv v2",
      unpriv: makeUnpriv(2, { extraPara: "Transient v2 paragraph replaced in v3." }),
      priv: makePriv(1, 2),
    },
    {
      date: "2025-01-15T10:00:00+00:00",
      msg: "docs: draft release v3",
      tag: "riscv-isa-release-20250115",
      unpriv: makeUnpriv(3),
      priv: makePriv(3, 4),
    },
    {
      date: "2025-04-10T10:00:00+00:00",
      msg: "docs: trim memory model v4",
      unpriv: makeUnpriv(4, { dropSecondHalf: true }),
      priv: makePriv(4, 4),
    },
    {
      date: "2025-06-01T10:00:00+00:00",
      msg: "docs: head v5",
      unpriv: makeUnpriv(5, { extraPara: "Final v5 extension paragraph." }),
      priv: makePriv(5, 6),
    },
  ];

  const identity = {
    GIT_AUTHOR_NAME: "RISC-V Fixture",
    GIT_AUTHOR_EMAIL: "fixture@riscv-cn.invalid",
    GIT_COMMITTER_NAME: "RISC-V Fixture",
    GIT_COMMITTER_EMAIL: "fixture@riscv-cn.invalid",
  };

  for (const c of commits) {
    writeFileSync(join(upstreamDir, "src", "riscv-unprivileged.adoc"), `${c.unpriv}\n`, "utf8");
    writeFileSync(join(upstreamDir, "src", "riscv-privileged.adoc"), `${c.priv}\n`, "utf8");
    const env = { ...identity, GIT_AUTHOR_DATE: c.date, GIT_COMMITTER_DATE: c.date };
    runGitOrThrow(["add", "-A"], upstreamDir, env);
    runGitOrThrow(["commit", "--quiet", "-m", c.msg], upstreamDir, env);
    if (c.tag) {
      runGitOrThrow(["tag", c.tag], upstreamDir, env);
    }
  }

  return upstreamDir;
}

describe("multithread pipeline parity (jobs=1 vs jobs=4)", () => {
  it("produces byte-for-byte identical sync, validate, and build-site artifacts between jobs=1 and jobs=4", async () => {
    const upstreamDir = buildMultiCommitUpstream();
    const dataDir1 = makeTempDir("riscv-par-data1-");
    const dataDir4 = makeTempDir("riscv-par-data4-");
    initEmptyDataRepo(dataDir1, upstreamDir);
    initEmptyDataRepo(dataDir4, upstreamDir);

    const syncRes1 = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir: dataDir1,
      provider: "mock",
      jobs: 1,
    });
    const syncRes4 = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir: dataDir4,
      provider: "mock",
      jobs: 4,
    });

    expect(syncRes4).toEqual(syncRes1);
    expect(syncRes1.processedCommits).toBe(5);
    expect(syncRes1.hasRemaining).toBe(false);

    //manifests/index.json, chapters/*.json, snapshots/*.json, and units/**/*.toml must match byte-for-byte
    expect(readFileSync(join(dataDir4, "manifests", "index.json"), "utf8")).toBe(
      readFileSync(join(dataDir1, "manifests", "index.json"), "utf8"),
    );

    const chaps1 = walkRelFiles(join(dataDir1, "manifests", "chapters"));
    const chaps4 = walkRelFiles(join(dataDir4, "manifests", "chapters"));
    expect(chaps4).toEqual(chaps1);
    expect(chaps1.length).toBeGreaterThanOrEqual(3);
    for (const rel of chaps1) {
      expect(readFileSync(join(dataDir4, "manifests", "chapters", rel), "utf8")).toBe(
        readFileSync(join(dataDir1, "manifests", "chapters", rel), "utf8"),
      );
    }

    const snaps1 = walkRelFiles(join(dataDir1, "manifests", "snapshots"));
    const snaps4 = walkRelFiles(join(dataDir4, "manifests", "snapshots"));
    expect(snaps4).toEqual(snaps1);
    expect(snaps1).toHaveLength(5);
    for (const rel of snaps1) {
      expect(readFileSync(join(dataDir4, "manifests", "snapshots", rel), "utf8")).toBe(
        readFileSync(join(dataDir1, "manifests", "snapshots", rel), "utf8"),
      );
    }

    const units1 = walkRelFiles(join(dataDir1, "units"));
    const units4 = walkRelFiles(join(dataDir4, "units"));
    expect(units4).toEqual(units1);
    expect(units1.length).toBeGreaterThanOrEqual(75);
    for (const rel of units1) {
      expect(readFileSync(join(dataDir4, "units", rel), "utf8")).toBe(
        readFileSync(join(dataDir1, "units", rel), "utf8"),
      );
    }

    // Validate parity on clean data
    const valClean1 = await validateDataRepo(dataDir1, { jobs: 1 });
    const valClean4 = await validateDataRepo(dataDir1, { jobs: 4 });
    expect(valClean1.ok).toBe(true);
    expect(valClean1.snapshotCount).toBe(5);
    expect(valClean1.unitCount).toBeGreaterThanOrEqual(75);
    expect(valClean4).toEqual(valClean1);

    // Validate parity on corrupted data (error list and ordering must match)
    const corruptDir = makeTempDir("riscv-par-corrupt-");
    cpSync(dataDir1, corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, "manifests", "snapshots", "bad.json"), "{invalid json", "utf8");
    const firstUnitRel = units1[0];
    const validToml = readFileSync(join(corruptDir, "units", firstUnitRel), "utf8");
    mkdirSync(join(corruptDir, "units", "zz"), { recursive: true });
    writeFileSync(join(corruptDir, "units", "zz", "wrong-shard.toml"), validToml, "utf8");
    mkdirSync(join(corruptDir, "units", "00"), { recursive: true });
    writeFileSync(join(corruptDir, "units", "00", "00000000000000000000000000000000.toml"), "broken = [\n", "utf8");

    const valBad1 = await validateDataRepo(corruptDir, { jobs: 1 });
    const valBad4 = await validateDataRepo(corruptDir, { jobs: 4 });
    expect(valBad1.ok).toBe(false);
    expect(valBad1.errors).toHaveLength(3);
    expect(valBad4).toEqual(valBad1);

    // buildSiteData parity on the same data repo (jobs=1 vs jobs=4)
    const outDir1 = makeTempDir("riscv-par-site1-");
    const outDir4 = makeTempDir("riscv-par-site4-");
    const buildRes1 = await buildSiteData({ dataDir: dataDir1, outDir: outDir1, jobs: 1 });
    const buildRes4 = await buildSiteData({ dataDir: dataDir1, outDir: outDir4, jobs: 4 });
    expect(buildRes4).toEqual(buildRes1);
    expect(buildRes1.snapshots).toBe(5);
    expect(buildRes1.units).toBeGreaterThanOrEqual(75);

    for (const dirName of ["trees", "chapters", "packs", "meta"]) {
      const files1 = walkRelFiles(join(outDir1, dirName));
      const files4 = walkRelFiles(join(outDir4, dirName));
      expect(files4).toEqual(files1);
      for (const rel of files1) {
        expect(readFileSync(join(outDir4, dirName, rel), "utf8")).toBe(
          readFileSync(join(outDir1, dirName, rel), "utf8"),
        );
      }
    }
    expect(readFileSync(join(outDir4, "anchors.json"), "utf8")).toBe(
      readFileSync(join(outDir1, "anchors.json"), "utf8"),
    );

    const meta1 = walkRelFiles(join(outDir1, "meta"));
    const meta4 = walkRelFiles(join(outDir4, "meta"));
    expect(meta4).toEqual(meta1);
    for (const rel of meta1) {
      expect(readFileSync(join(outDir4, "meta", rel), "utf8")).toBe(
        readFileSync(join(outDir1, "meta", rel), "utf8"),
      );
    }

    expect(readFileSync(join(outDir4, "search.json"), "utf8")).toBe(
      readFileSync(join(outDir1, "search.json"), "utf8"),
    );

    const idx1 = JSON.parse(readFileSync(join(outDir1, "index.json"), "utf8"));
    const idx4 = JSON.parse(readFileSync(join(outDir4, "index.json"), "utf8"));
    delete idx1.generated_at;
    delete idx4.generated_at;
    expect(idx4).toEqual(idx1);
  }, 30_000);

  it("matches jobs=1 vs jobs=4 byte-for-byte during multi-snapshot Step 2 recovery", async () => {
    const upstreamDir = buildMultiCommitUpstream();
    const seedDataDir = makeTempDir("riscv-par-seed-");
    initEmptyDataRepo(seedDataDir, upstreamDir);

    // Run partial sync hitting maxBatches=1: commits & snapshot manifests are recorded,
    // translating the shortest page first (Supervisor-Level ISA, 19 translatable units) while leaving the remaining chapters/snapshots.
    const partial = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir: seedDataDir,
      provider: "mock",
      maxBatches: 1,
      jobs: 4,
    });
    expect(partial.processedCommits).toBe(5);
    expect(partial.translatedUnits).toBe(19);
    expect(partial.hasRemaining).toBe(true);

    const resumeDir1 = makeTempDir("riscv-par-resume1-");
    const resumeDir4 = makeTempDir("riscv-par-resume4-");
    cpSync(seedDataDir, resumeDir1, { recursive: true });
    cpSync(seedDataDir, resumeDir4, { recursive: true });

    const res1 = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir: resumeDir1,
      provider: "mock",
      jobs: 1,
    });
    const res4 = await runSync({
      upstreamUrlOrPath: upstreamDir,
      dataDir: resumeDir4,
      provider: "mock",
      jobs: 4,
    });

    expect(res1.processedCommits).toBe(0);
    expect(res1.translatedUnits).toBeGreaterThan(20);
    expect(res1.hasRemaining).toBe(false);
    expect(res4).toEqual(res1);

    const units1 = walkRelFiles(join(resumeDir1, "units"));
    const units4 = walkRelFiles(join(resumeDir4, "units"));
    expect(units4).toEqual(units1);
    for (const rel of units1) {
      expect(readFileSync(join(resumeDir4, "units", rel), "utf8")).toBe(
        readFileSync(join(resumeDir1, "units", rel), "utf8"),
      );
    }

    expect(readFileSync(join(resumeDir4, "manifests", "index.json"), "utf8")).toBe(
      readFileSync(join(resumeDir1, "manifests", "index.json"), "utf8"),
    );
  }, 30_000);
});
