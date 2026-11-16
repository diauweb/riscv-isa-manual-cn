import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.ts";
import { runWorkspace } from "../jobs/index.ts";
import { defaultLog, info, step, success, type Logger } from "../log.ts";
import { ensureData } from "../workspace/index.ts";

function toolVersion(cmd: string[]): string | null {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return proc.exitCode === 0 ? proc.stdout.toString("utf8").trim() : null;
}

export interface SetupOptions {
  hooks?: boolean;
  log?: Logger;
}

/** One-time developer setup. Safe to re-run. */
export async function runSetup(cfg: AppConfig, opts: SetupOptions = {}): Promise<void> {
  const log = opts.log ?? defaultLog;
  const root = cfg.repoRoot;

  step("toolchain", log);
  const git = toolVersion(["git", "--version"]);
  if (!git) throw new Error("git is required but was not found on PATH");
  info(`bun ${Bun.version}`, log);
  info(git, log);

  step("local config", log);
  const dotEnv = join(root, ".env");
  const existing = [".env", ".env.local"].filter((f) => existsSync(join(root, f)));
  if (existing.length > 0) {
    info(`${existing.join(" and ")} exists`, log);
  } else {
    copyFileSync(join(root, ".env.example"), dotEnv);
    info("created .env from .env.example (gitignored; put API keys or personal overrides there)", log);
  }

  step("git hooks", log);
  if (Bun.spawnSync(["git", "rev-parse", "--git-dir"], { cwd: root, stdout: "pipe", stderr: "pipe" }).exitCode === 0) {
    Bun.spawnSync(["git", "config", "core.hooksPath", ".githooks"], { cwd: root });
    info("enabled .githooks (commit-msg: Conventional Commits; pre-push: bun run check)", log);
  } else {
    info("skipped (not a git checkout)", log);
  }

  step("workspace", log);
  if (cfg.upstreamKind === "remote") {
    ensureData(cfg, log);
  } else {
    await runWorkspace(cfg, log);
  }

  success(
    `setup complete. Next:\n` +
      `    bun run dev          # viewer over ${cfg.dataDir} with live reload\n` +
      `    bun run check        # exactly what CI runs\n` +
      `    bun run config       # where every setting comes from`,
    log,
  );
}
