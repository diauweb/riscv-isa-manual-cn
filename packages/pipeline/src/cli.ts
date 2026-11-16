import { join } from "node:path";
import { parseArgs } from "node:util";
import { formatConfigForDisplay, resolveAppConfig, type AppConfig } from "./config.ts";
import { runDev } from "./dev/serve.ts";
import { runSetup } from "./dev/setup.ts";
import { emitJson, logger, parseVerbosity, setVerbosity } from "./log.ts";
import {
  emitOutput,
  runBuild,
  runBuildSiteStep,
  runCheck,
  runDeployJob,
  runSyncJob,
  runSyncStep,
  runValidateStep,
  runWorkspace,
  viewerEnv,
  childEnv,
} from "./jobs/index.ts";
import { publishData, workspaceStatus } from "./workspace/index.ts";

const USAGE = `Usage: bun run <command> [flags]      (or: bun packages/pipeline/src/cli.ts <command>)

Primitives
  setup [--hooks]           One-time: .env.local, optional git hooks, workspace
  config                    Resolved settings, where each comes from, workspace status
  workspace [--fresh [--yes]] Ensure .work/: upstream (fixture | mirror | path) + data repo
  sync                      Sync upstream commits and translate (budgeted)
  validate-data             Validate the data repository
  build-site                Build viewer JSON into SITE_OUT_DIR (dev server data)
  build                     Build the Pages artifact into DIST_DIR (viewer + data)
  preview                   Serve DIST_DIR like GitHub Pages
  dev                       Vite dev server with live reload on data changes
  publish:data [--yes]      Push committed data-repo work (dry run unless allowed)
  check [--skip-typecheck] [--skip-test] [--skip-e2e]
                            Typecheck, tests, e2e rehearsal of job:sync + job:deploy

Jobs (what GitHub Actions runs; identical locally)
  job ci                    = check
  job sync [--yes]          = workspace → sync → validate → publish:data
  job deploy                = workspace → validate → build

Common flags
  --env-file <path>  --upstream <url|path|fixture>
  --data <dir>  --out <dir>  --provider <id>  --model <id>  --base-url <url>
  --reasoning-effort <level>  --llm-concurrency <n>
  --max-input-tokens <n>  --max-output-tokens <n>
  --max-minutes <n>  --max-batches <n>  -j | --jobs <n>  --baseline-date <YYYY-MM-DD>
  --fail-fast  --no-fail-fast  --no-commit  --data-repo-url <url>  --upstream-repo-url <url>
  -v | -vv | -vvv | --verbose <1|2|3>   Debug verbosity (1: steps, 2: docs/batches, 3: blocks)

Precedence: CLI flags > --env-file > shell env > DOTENV > .env.local > .env > defaults`;

function printUsage(): void {
  process.stderr.write(`${USAGE}\n`);
}

function parseOptionalFlagNumber(
  raw: string | undefined,
  flagName: string,
  integerOnly: boolean,
): number | undefined {
  if (raw === undefined) return undefined;
  const num = Number(raw);
  const valid = integerOnly ? Number.isInteger(num) && num > 0 : Number.isFinite(num) && num > 0;
  if (!valid) {
    logger.error(`Invalid ${flagName} value: ${raw}`);
    process.exit(1);
  }
  return num;
}

function fail(message: string): never {
  logger.error(message);
  process.exit(1);
}

function normalizeVerboseArgs(rawArgs: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "-v") {
      out.push("--verbose=1");
    } else if (arg === "-vv") {
      out.push("--verbose=2");
    } else if (arg === "-vvv") {
      out.push("--verbose=3");
    } else if (arg === "--verbose") {
      const next = rawArgs[i + 1];
      if (next !== undefined && /^[0-3]$/.test(next)) {
        out.push(`--verbose=${next}`);
        i++;
      } else {
        out.push("--verbose=1");
      }
    } else {
      out.push(arg);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let subcommand = args[0];
  if (!subcommand || subcommand === "-h" || subcommand === "--help") {
    printUsage();
    process.exit(subcommand ? 0 : 1);
  }

  const { values, positionals } = parseArgs({
    args: normalizeVerboseArgs(args.slice(1)),
    options: {
      "env-file": { type: "string" },
      upstream: { type: "string" },
      data: { type: "string" },
      out: { type: "string" },
      "max-minutes": { type: "string" },
      "max-batches": { type: "string" },
      "baseline-date": { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      "reasoning-effort": { type: "string" },
      "llm-concurrency": { type: "string" },
      "max-input-tokens": { type: "string" },
      "max-output-tokens": { type: "string" },
      "data-repo-url": { type: "string" },
      "upstream-repo-url": { type: "string" },
      jobs: { type: "string", short: "j" },
      "fail-fast": { type: "boolean", default: false },
      "no-fail-fast": { type: "boolean", default: false },
      "no-commit": { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      hooks: { type: "boolean", default: false },
      "skip-typecheck": { type: "boolean", default: false },
      "skip-test": { type: "boolean", default: false },
      "skip-e2e": { type: "boolean", default: false },
      verbose: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  if (subcommand === "job") {
    const jobName = positionals[0];
    if (!jobName) fail("missing job name (ci | sync | deploy)");
    subcommand = `job:${jobName}`;
  }

  if (values["fail-fast"] && values["no-fail-fast"]) {
    fail("Cannot combine --fail-fast and --no-fail-fast");
  }

  const cfg: AppConfig = resolveAppConfig({
    envFile: values["env-file"],
    upstream: values.upstream,
    data: values.data,
    out: values.out,
    dataRepoUrl: values["data-repo-url"],
    upstreamRepoUrl: values["upstream-repo-url"],
    baselineDate: values["baseline-date"],
    maxMinutes: parseOptionalFlagNumber(values["max-minutes"], "--max-minutes", false),
    maxBatches: parseOptionalFlagNumber(values["max-batches"], "--max-batches", true),
    provider: values.provider,
    model: values.model,
    baseUrl: values["base-url"],
    reasoningEffort: values["reasoning-effort"],
    llmConcurrency: parseOptionalFlagNumber(values["llm-concurrency"], "--llm-concurrency", true),
    maxInputTokens: parseOptionalFlagNumber(values["max-input-tokens"], "--max-input-tokens", true),
    maxOutputTokens: parseOptionalFlagNumber(values["max-output-tokens"], "--max-output-tokens", true),
    commitChanges: values["no-commit"] ? false : undefined,
    failFast: values["fail-fast"] ? true : values["no-fail-fast"] ? false : undefined,
    jobs: parseOptionalFlagNumber(values.jobs, "--jobs", true),
  });

  if (values.verbose !== undefined) {
    setVerbosity(parseVerbosity(values.verbose));
  } else {
    setVerbosity(parseVerbosity(process.env.VERBOSE));
  }

  switch (subcommand) {
    case "config": {
      emitJson({ ...formatConfigForDisplay(cfg), workspace: workspaceStatus(cfg) }, true);
      return;
    }

    case "setup":
      await runSetup(cfg, { hooks: values.hooks });
      return;

    case "workspace": {
      const { upstream } = await runWorkspace(cfg, { fresh: values.fresh, yes: values.yes });
      emitJson({ upstream, dataDir: cfg.dataDir, ...workspaceStatus(cfg) }, true);
      return;
    }

    case "sync": {
      const { upstream } = await runWorkspace(cfg);
      const result = await runSyncStep(cfg, upstream);
      emitOutput("has_remaining", result.hasRemaining ? "true" : "false");
      emitJson(result);
      return;
    }

    case "validate-data": {
      const result = await runValidateStep(cfg);
      emitJson(result, true);
      if (!result.ok) process.exit(1);
      return;
    }

    case "build-site": {
      await runWorkspace(cfg, { requireLocal: true });
      const result = await runBuildSiteStep(cfg);
      emitJson(result);
      return;
    }

    case "build": {
      await runWorkspace(cfg, { requireLocal: true });
      const result = await runBuild(cfg);
      emitJson(result);
      return;
    }

    case "preview": {
      const proc = Bun.spawn(["bun", "run", "preview", "--outDir", cfg.distDir], {
        cwd: join(cfg.repoRoot, "packages", "viewer"),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: childEnv(viewerEnv(cfg)),
      });
      process.exit(await proc.exited);
    }

    case "dev":
      process.exit(await runDev(cfg));

    case "publish:data": {
      const result = publishData(cfg, { yes: values.yes });
      emitJson({ pushed: result.pushed, reason: result.reason, commits: result.pending.length });
      return;
    }

    case "check":
    case "job:ci":
      await runCheck(cfg, {
        typecheck: !values["skip-typecheck"],
        test: !values["skip-test"],
        e2e: !values["skip-e2e"],
      });
      return;

    case "job:sync": {
      const result = await runSyncJob(cfg, { yes: values.yes });
      emitJson({ sync: result.sync, published: result.publish?.pushed ?? false });
      return;
    }

    case "job:deploy": {
      const result = await runDeployJob(cfg);
      emitJson({ distDir: cfg.distDir, ...result });
      return;
    }

    default:
      logger.error(`Unknown command: ${subcommand}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  if (process.env.DEBUG && err instanceof Error && err.stack) logger.error(err.stack);
  process.exit(1);
});
