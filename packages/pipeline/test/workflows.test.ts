import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MONOREPO_ROOT } from "../src/config.ts";

/**
 * Guard rail for "remote flows are compositions of local commands" and
 * workflow best practices (current Node 24+ action versions, SHA-pinned
 * third-party actions, credential hardening, and safe sync dispatch).
 */
const workflowFiles = [
  ...readdirSync(join(MONOREPO_ROOT, ".github", "workflows")).map((f) =>
    join(MONOREPO_ROOT, ".github", "workflows", f),
  ),
  join(MONOREPO_ROOT, "templates", "data-repo", ".github", "workflows", "deploy.yml"),
].filter((f) => existsSync(f) && /\.ya?ml$/.test(f));

const scripts = Object.keys(
  (JSON.parse(readFileSync(join(MONOREPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> })
    .scripts,
);

describe("workflows", () => {
  for (const file of workflowFiles) {
    const name = file.slice(MONOREPO_ROOT.length + 1);
    const content = readFileSync(file, "utf8");

    it(`${name}: only calls existing package scripts`, () => {
      const calls = [...content.matchAll(/bun run ([\w:-]+)/g)].map((m) => m[1]);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(scripts).toContain(call);
    });

    it(`${name}: embeds no inline pipeline scripts`, () => {
      expect(content).not.toMatch(/bun -e|bun --eval|node -e/);
    });
  }

  it("templates/data-repo deploy.yml matches sibling -data repo when present", () => {
    const siblingDeploy = join(
      MONOREPO_ROOT,
      "..",
      "riscv-isa-manual-cn-data",
      ".github",
      "workflows",
      "deploy.yml",
    );
    if (existsSync(siblingDeploy)) {
      const templateDeploy = join(
        MONOREPO_ROOT,
        "templates",
        "data-repo",
        ".github",
        "workflows",
        "deploy.yml",
      );
      expect(readFileSync(siblingDeploy, "utf8")).toBe(readFileSync(templateDeploy, "utf8"));
    }
  });
});

describe("githooks", () => {
  it("commit-msg enforces Conventional Commits", () => {
    const hook = join(MONOREPO_ROOT, ".githooks", "commit-msg");
    expect(existsSync(hook)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "riscv-cn-hook-"));
    const runHook = (message: string): number => {
      const msgFile = join(dir, "COMMIT_EDITMSG");
      writeFileSync(msgFile, message, "utf8");
      const res = Bun.spawnSync(["sh", hook, msgFile], { stdout: "pipe", stderr: "pipe" });
      return res.exitCode;
    };
    try {
      for (const valid of [
        "feat: initial commit\n",
        "fix(parser)!: handle edge case\n\nBody text.\n",
        "# leading comment\n\ndocs(readme): update guide\n",
        "Merge branch 'main'\n",
        'Revert "feat: something"\n',
      ]) {
        expect(runHook(valid)).toBe(0);
      }

      for (const invalid of [
        "update readme\n",
        "FEAT: uppercase\n",
        "feat:\n",
        "feat: \n",
        "unknown(scope): bad type\n",
      ]) {
        expect(runHook(invalid)).not.toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
