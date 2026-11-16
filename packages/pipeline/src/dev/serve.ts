import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { ManifestIndexSchema } from "@riscv-cn/schema";
import { siteBuildStampPath, type AppConfig } from "../config.ts";
import { childEnv, runBuildSiteStep, runSyncStep, runWorkspace, viewerEnv } from "../jobs/index.ts";
import { defaultLog, error, info, step, warn, type Logger } from "../log.ts";

function syncedCommitCount(dataDir: string): number {
  const p = join(dataDir, "manifests", "index.json");
  if (!existsSync(p)) return 0;
  return ManifestIndexSchema.parse(JSON.parse(readFileSync(p, "utf8"))).commits.length;
}

/**
 * `bun run dev`: ensure the workspace, (for the zero-cost mock provider) run the first
 * sync automatically, build site data, start Vite, and rebuild + reload whenever a
 * unit TOML / manifest / glossary in DATA_DIR changes.
 */
export async function runDev(cfg: AppConfig, log: Logger = defaultLog): Promise<number> {
  step("workspace", log);
  const { upstream } = await runWorkspace(cfg, { log, requireLocal: true });

  if (syncedCommitCount(cfg.dataDir) === 0) {
    if (cfg.aiProvider === "mock") {
      step("first run: sync with the zero-cost mock provider", log);
      const result = await runSyncStep(cfg, upstream);
      info(`sync: ${JSON.stringify(result)}`, log);
    } else {
      info(
        `data repo has no synced commits yet. Run \`bun run sync\` (provider: ${cfg.aiProvider}) ` +
          "or `bun run dev --upstream fixture --provider mock`.",
        log,
      );
    }
  }

  const stampPath = siteBuildStampPath(cfg);
  const renderCache = new Map<string, string>();
  let building = false;
  let pending = false;
  const rebuild = async (reason: string) => {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    try {
      const started = Date.now();
      if (renderCache.size > 100_000) renderCache.clear();
      const res = await runBuildSiteStep(cfg, cfg.siteOutDir, renderCache);
      mkdirSync(dirname(stampPath), { recursive: true });
      writeFileSync(stampPath, `${new Date().toISOString()}\n`, "utf8");
      info(
        `site data rebuilt (${reason}): ${res.chapters} chapters, ${res.packs} packs in ${Date.now() - started}ms`,
        log,
      );
    } catch (err) {
      error(`site rebuild failed: ${err instanceof Error ? err.message : String(err)}`, log);
    } finally {
      building = false;
      if (pending) {
        pending = false;
        void rebuild("queued changes");
      }
    }
  };

  step(`build site data → ${cfg.siteOutDir}`, log);
  await rebuild("startup");

  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(cfg.dataDir, { recursive: true }, (_event, filename) => {
      const name = String(filename ?? "");
      if (name.startsWith(".git") || !/\.(toml|json|md)$/.test(name)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void rebuild(name), 250);
    });
    info(`watching ${cfg.dataDir} for changes`, log);
  } catch (err) {
    warn(`file watching unavailable (${String(err)}); restart \`bun run dev\` after edits`, log);
  }

  step(`vite dev server (http://localhost:${cfg.viewerPort})`, log);
  const child = Bun.spawn(["bun", "run", "dev"], {
    cwd: join(cfg.repoRoot, "packages", "viewer"),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: childEnv(viewerEnv(cfg)),
  });
  const stop = () => child.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const code = await child.exited;
  watcher?.close();
  return code;
}
