import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGit, runGitOrThrow } from "../git.ts";

/**
 * A tiny, deterministic stand-in for `riscv/riscv-isa-manual`.
 *
 * Three commits with fixed author/committer dates and identity produce identical
 * SHAs on every machine, so local runs, `bun run check`, and CI are reproducible.
 * It covers the features the pipeline cares about: two volumes, paragraphs,
 * code blocks, tables, a ratified tag, a draft release tag, edits, insertions,
 * and a deletion between versions.
 */
export interface FixtureCommit {
  date: string;
  message: string;
  tag?: string;
  files: Record<string, string>;
}

const UNPRIV_V1 = [
  "= RISC-V Unprivileged Specification",
  "",
  "== RV32I Base Integer Instruction Set",
  "",
  "RV32I provides qty:32[bits] registers `x0` through `x31` (see <<_memory_model>>).",
  "",
  "The insn:add[] instruction adds two registers and writes `rd`.",
  "",
  "[source,asm]",
  "----",
  "add x1, x2, x3",
  "----",
  "",
  "|===",
  "| Field | Bits",
  "| `rd` | 11:7",
  "| `rs1` | 19:15",
  "|===",
  "",
  "[[_memory_model]]",
  "== Memory Model",
  "",
  "A hart observes its own memory operations in program order.",
  "",
  "Loads and stores to the same address are never reordered by a single hart.",
].join("\n");

const UNPRIV_V2 = [
  "= RISC-V Unprivileged Specification",
  "",
  "== RV32I Base Integer Instruction Set",
  "",
  "RV32I provides qty:32[bits] registers `x0` through `x31` (see <<_memory_model>>).",
  "",
  "The insn:add[] instruction adds two registers and ignores overflow when writing `rd`.",
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
  "| `rs1` | 19:15",
  "|===",
  "",
  "[[_memory_model]]",
  "== Memory Model",
  "",
  "A hart observes its own memory operations in program order.",
  "",
  "Loads and stores to the same address are never reordered by a single hart.",
].join("\n");

const UNPRIV_V3 = UNPRIV_V2.replace(
  "Register `x0` is hardwired to 0.",
  "Register `x0` is hardwired with all bits equal to 0.",
).replace(
  "\n\nLoads and stores to the same address are never reordered by a single hart.",
  "",
);

const PRIV_V2 = [
  "= RISC-V Privileged Architecture",
  "",
  "== Machine-Level ISA",
  "",
  "Machine mode is the highest privilege mode and is mandatory for every hart.",
  "",
  "The csr:mstatus[] register tracks the current operating state of the hart.",
].join("\n");

const PRIV_V3 = PRIV_V2 + "\n\nThe `mtvec` register holds the trap vector base address.";

export const FIXTURE_COMMITS: FixtureCommit[] = [
  {
    date: "2024-04-01T10:00:00+00:00",
    message: "feat: initial RV32I and memory model chapters",
    tag: "20240411",
    files: { "src/riscv-unprivileged.adoc": UNPRIV_V1 },
  },
  {
    date: "2025-01-15T10:00:00+00:00",
    message: "docs: clarify ADD overflow, add x0 note and privileged volume",
    tag: "riscv-isa-release-20250115",
    files: { "src/riscv-unprivileged.adoc": UNPRIV_V2, "src/riscv-privileged.adoc": PRIV_V2 },
  },
  {
    date: "2025-06-01T10:00:00+00:00",
    message: "docs: reword x0, drop redundant memory-model sentence, add mtvec",
    files: { "src/riscv-unprivileged.adoc": UNPRIV_V3, "src/riscv-privileged.adoc": PRIV_V3 },
  },
];

function git(args: string[], cwd: string, env: Record<string, string> = {}): string {
  return runGitOrThrow(args, cwd, env).trim();
}

const FIXTURE_IDENTITY = {
  GIT_AUTHOR_NAME: "RISC-V Fixture",
  GIT_AUTHOR_EMAIL: "fixture@riscv-cn.invalid",
  GIT_COMMITTER_NAME: "RISC-V Fixture",
  GIT_COMMITTER_EMAIL: "fixture@riscv-cn.invalid",
};

/** Git config key recording which fixture definition a generated repo was built from. */
const FIXTURE_HASH_KEY = "riscv-cn.fixture-hash";

function fixtureHash(commits: FixtureCommit[]): string {
  return createHash("sha256").update(JSON.stringify(commits)).digest("hex").slice(0, 16);
}

/**
 * Creates (or recreates) the fixture upstream git repository at `dir`.
 * Returns the SHA of each commit in order.
 */
export function createFixtureUpstream(dir: string, commits: FixtureCommit[] = FIXTURE_COMMITS): string[] {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(["init", "--quiet", "-b", "main"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  git(["config", "tag.gpgsign", "false"], dir);

  const shas: string[] = [];
  for (const commit of commits) {
    for (const [rel, content] of Object.entries(commit.files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, `${content}\n`, "utf8");
    }
    const env = { ...FIXTURE_IDENTITY, GIT_AUTHOR_DATE: commit.date, GIT_COMMITTER_DATE: commit.date };
    git(["add", "-A"], dir, env);
    git(["commit", "--quiet", "-m", commit.message], dir, env);
    shas.push(git(["rev-parse", "HEAD"], dir));
    if (commit.tag) git(["tag", commit.tag], dir, env);
  }
  // Recorded last, so an interrupted generation is never considered current.
  git(["config", FIXTURE_HASH_KEY, fixtureHash(commits)], dir);
  return shas;
}

/** True if `dir` holds a complete fixture generated from the current `FIXTURE_COMMITS`. */
export function isFixtureCurrent(dir: string): boolean {
  if (!existsSync(join(dir, ".git"))) return false;
  const res = runGit(["config", "--get", FIXTURE_HASH_KEY], dir);
  return res.exitCode === 0 && res.stdout.trim() === fixtureHash(FIXTURE_COMMITS);
}
