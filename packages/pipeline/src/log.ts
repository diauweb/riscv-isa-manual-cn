import { createConsola, LogLevels, type ConsolaInstance, type ConsolaReporter } from "consola";

/** Progress logging for CLI commands. Goes to stderr so stdout stays machine-readable JSON. */
export type Logger = (message: string) => void;

export type VerbosityLevel = 0 | 1 | 2 | 3;

export interface ActiveProgress {
  clearLine(): void;
  render(): void;
}

let activeProgress: ActiveProgress | null = null;
let verbosityOverride: VerbosityLevel | null = null;

export function setActiveProgress(progress: ActiveProgress | null): void {
  activeProgress = progress;
}

export function parseVerbosity(raw: string | number | boolean | undefined): VerbosityLevel {
  if (raw === undefined || raw === false || raw === "") return 0;
  if (raw === true) return 1;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    if (raw >= 3) return 3;
    return Math.floor(raw) as VerbosityLevel;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "true" || trimmed === "yes") return 1;
  if (trimmed === "false" || trimmed === "no") return 0;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num <= 0) return 0;
  if (num >= 3) return 3;
  return Math.floor(num) as VerbosityLevel;
}

function toConsolaLevel(level: VerbosityLevel): number {
  switch (level) {
    case 0:
      return LogLevels.info;
    case 1:
      return LogLevels.debug;
    case 2:
      return LogLevels.trace;
    case 3:
      return LogLevels.verbose;
  }
}

function wrapProgressSafeReporter(reporter: ConsolaReporter): ConsolaReporter {
  return {
    log(logObj, ctx) {
      if (activeProgress) {
        activeProgress.clearLine();
        reporter.log(logObj, ctx);
        activeProgress.render();
        return;
      }
      reporter.log(logObj, ctx);
    },
  };
}

/** Shared consola instance writing all human-readable logs to stderr. */
export const logger: ConsolaInstance = createConsola({
  level: toConsolaLevel(parseVerbosity(process.env.VERBOSE)),
  stdout: process.stderr,
  stderr: process.stderr,
});

logger.setReporters(logger.options.reporters.map(wrapProgressSafeReporter));

export function setVerbosity(level: VerbosityLevel | null): void {
  verbosityOverride = level;
  logger.level = toConsolaLevel(getVerbosity());
}

export function getVerbosity(): VerbosityLevel {
  if (verbosityOverride !== null) return verbosityOverride;
  return parseVerbosity(process.env.VERBOSE);
}

export function isVerbose(level: 1 | 2 | 3): boolean {
  return getVerbosity() >= level;
}

export const defaultLog: Logger = (msg) => {
  logger.info(msg);
};

export function info(message: string, log: Logger = defaultLog): void {
  if (log === defaultLog) {
    logger.info(message);
    return;
  }
  log(message);
}

export function warn(message: string, log: Logger = defaultLog): void {
  if (log === defaultLog) {
    logger.warn(message);
    return;
  }
  log(message);
}

export function error(message: string, log: Logger = defaultLog): void {
  if (log === defaultLog) {
    logger.error(message);
    return;
  }
  log(message);
}

export function success(message: string, log: Logger = defaultLog): void {
  if (log === defaultLog) {
    logger.success(message);
    return;
  }
  log(message);
}

export function step(title: string, log: Logger = defaultLog): void {
  if (log === defaultLog) {
    logger.start(title);
    return;
  }
  log(title);
}

/**
 * Verbose debug logging gated by level:
 * - 1 (-v): big steps / phases (consola `debug`)
 * - 2 (-vv): per-document / per-commit / per-chapter / per-batch (consola `trace`)
 * - 3 (-vvv): per-block / per-unit granular (consola `verbose`)
 */
export function vlog(level: 1 | 2 | 3, message: string, log: Logger = defaultLog): void {
  if (getVerbosity() < level) return;
  if (log !== defaultLog) {
    log(message);
    return;
  }
  if (level === 1) logger.debug(message);
  else if (level === 2) logger.trace(message);
  else logger.verbose(message);
}

/** Writes machine-readable JSON to stdout (never mixed with stderr logs). */
export function emitJson(value: unknown, pretty = false): void {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`);
}
