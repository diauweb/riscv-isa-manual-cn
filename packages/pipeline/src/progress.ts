import cliProgress from "cli-progress";
import { isCiEnv, isTruthyEnv } from "./config.ts";
import { logger, setActiveProgress } from "./log.ts";

export interface ProgressStream {
  write(chunk: string): unknown;
  columns?: number;
  isTTY?: boolean;
}

export interface ProgressOptions {
  label: string;
  total: number;
  enabled?: boolean;
  stream?: ProgressStream;
  /** Environment override for CI detection (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
}

export interface TranslateWorkerState {
  documentTitle: string;
  unitCount: number;
  passIndex?: number;
  totalPasses?: number;
  startedAt?: number;
  progress: LlmProgressSnapshot | null;
}

export interface TranslateProgressOptions extends ProgressOptions {
  concurrency: number;
  totalPages?: number;
}

export interface TranslateProgressBar {
  update(current: number, pages?: { donePages: number; totalPages: number }): void;
  setPages(donePages: number, totalPages: number): void;
  setWorker(slotIndex: number, state: TranslateWorkerState, forceRender?: boolean): void;
  clearWorker(slotIndex: number): void;
  done(summary?: string | ProgressDoneOptions): void;
  clear(): void;
}

export interface ProgressDoneOptions {
  detail?: string;
}

export interface ProgressBar {
  update(current: number, detail?: string): void;
  increment(detail?: string): void;
  done(summary?: string | ProgressDoneOptions): void;
  clear(): void;
}

export interface LlmTokenSnapshot {
  /** Output tokens accumulated so far (exact + locally estimated). */
  tokens: number;
  /** True when every non-zero contribution came from exact provider token usage. */
  exact: boolean;
}

export type LlmProgressPhase = "uploading" | "waiting" | "stream" | "finish";

export interface LlmProgressSnapshot {
  phase: LlmProgressPhase;
  inputTokens: number;
  exactInput: boolean;
  outputTokens: number;
  exactOutput: boolean;
  tokPerSec?: number;
}

export function formatCompactCount(count: number): string {
  const safe = Math.max(0, Math.floor(count));
  if (safe < 1_000) {
    return String(safe);
  }
  if (safe < 999_950) {
    return `${(safe / 1_000).toFixed(1)}k`;
  }
  return `${(safe / 1_000_000).toFixed(2)}M`;
}

export function formatLlmTokens(snapshot: LlmTokenSnapshot): string {
  const safe = Math.max(0, Math.floor(snapshot.tokens));
  if (safe === 0 || snapshot.exact) {
    return `${formatCompactCount(safe)} tokens`;
  }
  return `~${formatCompactCount(safe)} tokens`;
}

export function formatTokPerSec(tokPerSec: number): string {
  return `${tokPerSec.toFixed(1)} tok/s`;
}

function formatTokenSide(arrow: "↑" | "↓", count: number, exact: boolean): string {
  const safe = Math.max(0, Math.floor(count));
  const prefix = safe > 0 && !exact ? "~" : "";
  return `${arrow} ${prefix}${formatCompactCount(safe)}`;
}

/**
 * Formats LLM call / batch progress:
 * - `↑ ~14.2k tokens (uploading)` while sending HTTP request
 * - `↑ ~14.2k tokens (waiting)` once headers arrive while awaiting first token
 * - `↑ ~14.2k ↓ ~420 tokens (68.5 tok/s)` while streaming tokens
 * - `↑ 13.9k ↓ 1.5k tokens (71.2 tok/s)` on completion
 */
export function formatLlmProgress(snapshot: LlmProgressSnapshot): string {
  const up = formatTokenSide("↑", snapshot.inputTokens, snapshot.exactInput);
  if (snapshot.phase === "uploading") {
    return `${up} tokens (uploading)`;
  }
  if (snapshot.phase === "waiting") {
    return `${up} tokens (waiting)`;
  }
  const down = formatTokenSide("↓", snapshot.outputTokens, snapshot.exactOutput);
  const rate =
    snapshot.tokPerSec !== undefined &&
    Number.isFinite(snapshot.tokPerSec) &&
    snapshot.tokPerSec > 0
      ? ` (${formatTokPerSec(snapshot.tokPerSec)})`
      : "";
  return `${up} ${down} tokens${rate}`;
}

export function formatTranslateHeaderLine(params: {
  label: string;
  current: number;
  total: number;
  activeWorkers: number;
  donePages: number;
  totalPages: number;
  elapsedMs?: number;
  barSize?: number;
}): string {
  const safeTotal = Math.max(0, Math.floor(params.total));
  const safeCurrent = Math.min(safeTotal, Math.max(0, Math.floor(params.current)));
  const progress = safeTotal > 0 ? safeCurrent / safeTotal : 0;
  const pct = Math.round(progress * 100);
  const barSize = params.barSize ?? 20;
  const filled = Math.round(progress * barSize);
  const barStr = "█".repeat(filled) + "░".repeat(Math.max(0, barSize - filled));
  const elapsed = formatDuration(params.elapsedMs ?? 0);
  return `${params.label} [${barStr}] ${safeCurrent}/${safeTotal} (${pct}%) | ${params.activeWorkers} actives | ${params.donePages} / ${params.totalPages} Pages | ${elapsed}`;
}

export function formatWorkerProgressLine(
  workerIndex: number,
  workerCount: number,
  slot: TranslateWorkerState | null,
  elapsedMs?: number,
): string {
  const numWidth = String(Math.max(1, workerCount)).length;
  const workerLabel = `Worker #${String(workerIndex + 1).padEnd(numWidth)}`;
  if (slot === null) {
    return `${workerLabel} | idle`;
  }

  const up = formatTokenSide(
    "↑",
    slot.progress?.inputTokens ?? 0,
    slot.progress?.exactInput ?? false,
  );
  const down = formatTokenSide(
    "↓",
    slot.progress?.outputTokens ?? 0,
    slot.progress?.exactOutput ?? false,
  );

  let statusOrSpeed: string;
  if (!slot.progress) {
    statusOrSpeed = "starting";
  } else if (slot.progress.phase === "uploading") {
    statusOrSpeed = "uploading";
  } else if (slot.progress.phase === "waiting") {
    statusOrSpeed = "waiting";
  } else if (slot.progress.phase === "stream") {
    statusOrSpeed =
      slot.progress.tokPerSec !== undefined &&
      Number.isFinite(slot.progress.tokPerSec) &&
      slot.progress.tokPerSec > 0
        ? `${slot.progress.tokPerSec.toFixed(1)} t/s`
        : "streaming";
  } else {
    statusOrSpeed =
      slot.progress.tokPerSec !== undefined &&
      Number.isFinite(slot.progress.tokPerSec) &&
      slot.progress.tokPerSec > 0
        ? `${slot.progress.tokPerSec.toFixed(1)} t/s`
        : "done";
  }

  const cleanTitle = slot.documentTitle.replace(/\s+/g, " ").trim();
  const passSuffix =
    slot.totalPasses !== undefined && slot.totalPasses > 1 && slot.passIndex !== undefined
      ? ` (pass ${slot.passIndex + 1}/${slot.totalPasses})`
      : "";
  const resolvedElapsedMs =
    elapsedMs ?? (slot.startedAt !== undefined ? Date.now() - slot.startedAt : 0);
  const elapsed = formatDuration(resolvedElapsedMs);
  return `${workerLabel} | ${up} ${down} | ${statusOrSpeed} | ${slot.unitCount} Units | ${elapsed} | ${cleanTitle}${passSuffix}`;
}

export function truncateToColumns(line: string, maxCols: number): string {
  if (Bun.stringWidth(line) <= maxCols) {
    return line;
  }
  if (maxCols <= 1) {
    return maxCols === 1 ? "…" : "";
  }
  let acc = "";
  let width = 0;
  for (const ch of line) {
    const w = Bun.stringWidth(ch);
    if (width + w > maxCols - 1) {
      break;
    }
    acc += ch;
    width += w;
  }
  return `${acc}…`;
}

/**
 * Progress bars are enabled only for interactive local development:
 * non-CI, stderr is a TTY, TERM is not "dumb", and NO_PROGRESS is unset.
 */
export function shouldShowProgress(
  env: Record<string, string | undefined> = process.env,
  isTTY: boolean = Boolean(process.stderr.isTTY),
): boolean {
  if (isCiEnv(env)) return false;
  if (!isTTY) return false;
  if (env.TERM === "dumb") return false;
  if (isTruthyEnv(env.NO_PROGRESS)) return false;
  return true;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const totalSec = Math.floor(seconds);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m${String(secs).padStart(2, "0")}s`;
}

const NOOP_PROGRESS: ProgressBar = {
  update() {},
  increment() {},
  done() {},
  clear() {},
};

function formatDoneSummary(
  label: string,
  current: number,
  total: number,
  startedAt: number,
  summary?: string | ProgressDoneOptions,
): string {
  const elapsed = formatDuration(Date.now() - startedAt);
  if (typeof summary === "string") {
    return summary;
  }
  const extra = summary?.detail ? `, ${summary.detail}` : "";
  return `${label} (${current}/${total}${extra}, ${elapsed})`;
}

/**
 * Lightweight progress tracker for CI runs: stays silent during updates and emits
 * a single completion summary line on `done()`.
 */
function createCiSummaryProgress(label: string, total: number): ProgressBar {
  const startedAt = Date.now();
  let current = 0;
  let finished = false;
  return {
    update(nextCurrent: number) {
      if (finished) return;
      current = Math.min(total, Math.max(0, nextCurrent));
    },
    increment() {
      if (finished) return;
      current = Math.min(total, current + 1);
    },
    done(summary?: string | ProgressDoneOptions) {
      if (finished) return;
      finished = true;
      logger.success(formatDoneSummary(label, current, total, startedAt, summary));
    },
    clear() {
      finished = true;
    },
  };
}

/**
 * Creates a terminal progress bar on stderr for local development using `cli-progress`.
 * Returns a CI summary tracker in CI (emitting one line on `done()`), or a no-op otherwise.
 */
export function createProgress(options: ProgressOptions): ProgressBar {
  const env = options.env ?? process.env;
  const enabled = options.enabled ?? shouldShowProgress(env);
  if (options.total <= 0) {
    return NOOP_PROGRESS;
  }
  if (!enabled) {
    if (options.enabled === undefined && !options.stream && isCiEnv(env)) {
      return createCiSummaryProgress(options.label, options.total);
    }
    return NOOP_PROGRESS;
  }

  const stream: ProgressStream = options.stream ?? process.stderr;
  const isDefaultStream = stream === process.stderr;
  const startedAt = Date.now();
  let current = 0;
  let detail = "";
  let finished = false;

  const bar = new cliProgress.SingleBar(
    {
      format: (opts, params, payload) => {
        const barStr = cliProgress.Format.BarFormat(params.progress, opts);
        const pct = Math.round(params.progress * 100);
        const elapsed = formatDuration(Date.now() - startedAt);
        const suffix = payload.detail ? ` | ${payload.detail}` : "";
        return `${payload.label} [${barStr}] ${params.value}/${params.total} (${pct}%) | ${elapsed}${suffix}`;
      },
      barCompleteChar: "█",
      barIncompleteChar: "░",
      barsize: 20,
      stream: stream as NodeJS.WriteStream,
      noTTYOutput: false,
      hideCursor: isDefaultStream,
      clearOnComplete: true,
      stopOnComplete: false,
      synchronousUpdate: !isDefaultStream,
      fps: isDefaultStream ? 10 : 2000,
    },
    cliProgress.Presets.shades_classic,
  );

  bar.start(options.total, 0, { label: options.label, detail: "" });

  const tickTimer = isDefaultStream
    ? setInterval(() => {
        if (!finished) bar.render();
      }, 200)
    : null;
  tickTimer?.unref?.();

  if (isDefaultStream) {
    setActiveProgress({
      clearLine() {
        stream.write("\r\x1b[2K");
      },
      render() {
        bar.render();
      },
    });
  }

  return {
    update(nextCurrent: number, nextDetail?: string) {
      if (finished) return;
      current = Math.min(options.total, Math.max(0, nextCurrent));
      if (nextDetail !== undefined) {
        detail = nextDetail.replace(/\s+/g, " ").trim();
      }
      bar.update(current, { label: options.label, detail });
      if (!isDefaultStream) bar.render();
    },
    increment(nextDetail?: string) {
      if (finished) return;
      current = Math.min(options.total, current + 1);
      if (nextDetail !== undefined) {
        detail = nextDetail.replace(/\s+/g, " ").trim();
      }
      bar.update(current, { label: options.label, detail });
      if (!isDefaultStream) bar.render();
    },
    done(summary?: string | ProgressDoneOptions) {
      if (finished) return;
      finished = true;
      if (tickTimer) clearInterval(tickTimer);
      bar.stop();
      if (isDefaultStream) {
        setActiveProgress(null);
      }
      const text = formatDoneSummary(options.label, current, options.total, startedAt, summary);
      if (isDefaultStream) {
        logger.success(text);
      } else {
        stream.write(`${text}\n`);
      }
    },
    clear() {
      if (finished) return;
      finished = true;
      if (tickTimer) clearInterval(tickTimer);
      bar.stop();
      if (isDefaultStream) {
        setActiveProgress(null);
      }
    },
  };
}

const NOOP_TRANSLATE_PROGRESS: TranslateProgressBar = {
  update() {},
  setPages() {},
  setWorker() {},
  clearWorker() {},
  done() {},
  clear() {},
};

function createCiSummaryTranslateProgress(label: string, total: number): TranslateProgressBar {
  const bar = createCiSummaryProgress(label, total);
  return {
    update(nextCurrent: number) {
      bar.update(nextCurrent);
    },
    setPages() {},
    setWorker() {},
    clearWorker() {},
    done(summary?: string | ProgressDoneOptions) {
      bar.done(summary);
    },
    clear() {
      bar.clear();
    },
  };
}

/**
 * Creates a multi-line terminal progress display on stderr for the translation stage:
 * one overall bar header line followed by `concurrency` fixed worker status lines.
 * Returns a CI summary tracker in CI (emitting one line on `done()`), or a no-op otherwise.
 */
export function createTranslateProgress(options: TranslateProgressOptions): TranslateProgressBar {
  const env = options.env ?? process.env;
  const enabled = options.enabled ?? shouldShowProgress(env);
  if (options.total <= 0) {
    return NOOP_TRANSLATE_PROGRESS;
  }
  if (!enabled) {
    if (options.enabled === undefined && !options.stream && isCiEnv(env)) {
      return createCiSummaryTranslateProgress(options.label, options.total);
    }
    return NOOP_TRANSLATE_PROGRESS;
  }

  const stream: ProgressStream = options.stream ?? process.stderr;
  const isDefaultStream = stream === process.stderr;
  const startedAt = Date.now();
  const workerCount = Math.max(1, Math.floor(options.concurrency));
  const slots: Array<TranslateWorkerState | null> = new Array(workerCount).fill(null);
  const slotStartedAt: Array<number | null> = new Array(workerCount).fill(null);

  let current = 0;
  let donePages = 0;
  let totalPages = Math.max(0, Math.floor(options.totalPages ?? 0));
  let hasRendered = false;
  let renderedLineCount = 0;
  let lastFrame = "";
  let lastRenderAt = 0;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let finished = false;
  let cursorRestored = false;

  const cancelTimer = () => {
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
  };

  const clearBlock = () => {
    cancelTimer();
    if (!hasRendered) return;
    const moveUp = renderedLineCount > 1 ? `\x1b[${renderedLineCount - 1}A` : "";
    stream.write(`${moveUp}\r\x1b[0J`);
    hasRendered = false;
    renderedLineCount = 0;
    lastFrame = "";
  };

  const renderBlock = (force = false) => {
    if (finished) return;
    if (isDefaultStream && !force && hasRendered) {
      const elapsed = Date.now() - lastRenderAt;
      if (elapsed < 50) {
        if (!throttleTimer) {
          throttleTimer = setTimeout(() => {
            throttleTimer = null;
            renderBlock(true);
          }, 50 - elapsed);
          throttleTimer.unref?.();
        }
        return;
      }
    }
    cancelTimer();

    const now = Date.now();
    const activeWorkers = slots.reduce((n, s) => n + (s !== null ? 1 : 0), 0);
    const maxCols =
      stream.columns && stream.columns > 0 ? stream.columns : stream.isTTY ? 80 : 200;
    const rawLines = [
      formatTranslateHeaderLine({
        label: options.label,
        current,
        total: options.total,
        activeWorkers,
        donePages,
        totalPages,
        elapsedMs: now - startedAt,
      }),
    ];
    for (let i = 0; i < workerCount; i++) {
      const slot = slots[i];
      const workerElapsedMs =
        slot !== null ? now - (slot.startedAt ?? slotStartedAt[i] ?? now) : 0;
      rawLines.push(formatWorkerProgressLine(i, workerCount, slot, workerElapsedMs));
    }
    const lines = rawLines.map((line) => truncateToColumns(line, maxCols));
    const frame = lines.join("\n");
    if (hasRendered && frame === lastFrame) {
      return;
    }

    const prefix = hasRendered
      ? `${renderedLineCount > 1 ? `\x1b[${renderedLineCount - 1}A` : ""}\r`
      : "\r";
    const body = lines.map((l) => `${l}\x1b[K`).join("\n");
    stream.write(`${prefix}${body}`);
    hasRendered = true;
    renderedLineCount = lines.length;
    lastFrame = frame;
    lastRenderAt = now;
  };

  const restoreCursor = () => {
    if (isDefaultStream && !cursorRestored) {
      cursorRestored = true;
      stream.write("\x1b[?25h");
    }
  };

  const onProcessExit = () => {
    restoreCursor();
  };

  if (isDefaultStream) {
    stream.write("\x1b[?25l");
    process.once("exit", onProcessExit);
    setActiveProgress({
      clearLine() {
        clearBlock();
      },
      render() {
        renderBlock(true);
      },
    });
  }

  const cleanup = () => {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    clearBlock();
    if (isDefaultStream) {
      setActiveProgress(null);
      process.removeListener("exit", onProcessExit);
      restoreCursor();
    }
  };

  renderBlock(true);

  if (isDefaultStream) {
    tickTimer = setInterval(() => {
      renderBlock(true);
    }, 200);
    tickTimer.unref?.();
  }

  return {
    update(nextCurrent: number, pages?: { donePages: number; totalPages: number }) {
      if (finished) return;
      current = Math.min(options.total, Math.max(0, nextCurrent));
      if (pages) {
        donePages = Math.max(0, pages.donePages);
        totalPages = Math.max(0, pages.totalPages);
      }
      renderBlock(true);
    },
    setPages(nextDone: number, nextTotal: number) {
      if (finished) return;
      donePages = Math.max(0, nextDone);
      totalPages = Math.max(0, nextTotal);
      renderBlock(true);
    },
    setWorker(slotIndex: number, state: TranslateWorkerState, forceRender = true) {
      if (finished) return;
      if (slotIndex < 0 || slotIndex >= workerCount) return;
      if (state.startedAt !== undefined) {
        slotStartedAt[slotIndex] = state.startedAt;
      } else if (
        slotStartedAt[slotIndex] === null ||
        slots[slotIndex]?.documentTitle !== state.documentTitle
      ) {
        slotStartedAt[slotIndex] = Date.now();
      }
      slots[slotIndex] = state;
      renderBlock(forceRender);
    },
    clearWorker(slotIndex: number) {
      if (finished) return;
      if (slotIndex < 0 || slotIndex >= workerCount) return;
      slots[slotIndex] = null;
      slotStartedAt[slotIndex] = null;
      renderBlock(true);
    },
    done(summary?: string | ProgressDoneOptions) {
      if (finished) return;
      finished = true;
      cleanup();
      const text = formatDoneSummary(options.label, current, options.total, startedAt, summary);
      if (isDefaultStream) {
        logger.success(text);
      } else {
        stream.write(`${text}\n`);
      }
    },
    clear() {
      if (finished) return;
      finished = true;
      cleanup();
    },
  };
}
