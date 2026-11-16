import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "../src/log.ts";
import {
  createProgress,
  createTranslateProgress,
  formatCompactCount,
  formatDuration,
  formatLlmProgress,
  formatLlmTokens,
  formatTokPerSec,
  shouldShowProgress,
} from "../src/progress.ts";

describe("shouldShowProgress", () => {
  test("enables only in interactive non-CI terminals", () => {
    expect(shouldShowProgress({}, true)).toBe(true);
    expect(shouldShowProgress({ TERM: "xterm-256color" }, true)).toBe(true);
    expect(shouldShowProgress({ CI: "true" }, true)).toBe(false);
    expect(shouldShowProgress({ GITHUB_ACTIONS: "true" }, true)).toBe(false);
    expect(shouldShowProgress({}, false)).toBe(false);
    expect(shouldShowProgress({ TERM: "dumb" }, true)).toBe(false);
    expect(shouldShowProgress({ NO_PROGRESS: "1" }, true)).toBe(false);
  });
});

describe("formatDuration", () => {
  test("formats sub-minute and minute+ durations", () => {
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(1250)).toBe("1.3s");
    expect(formatDuration(65_000)).toBe("1m05s");
    expect(formatDuration(120_000)).toBe("2m00s");
  });
});

describe("createProgress", () => {
  test("is a no-op when disabled or total is 0", () => {
    const chunks: string[] = [];
    const stream = { write: (c: string) => chunks.push(c), columns: 80, isTTY: true };

    const disabled = createProgress({ label: "Test", total: 10, enabled: false, stream });
    disabled.update(5, "step");
    disabled.increment();
    disabled.done();
    expect(chunks).toEqual([]);

    const empty = createProgress({ label: "Empty", total: 0, enabled: true, stream });
    empty.update(0);
    empty.done();
    expect(chunks).toEqual([]);
  });

  test("renders updates and completion line when enabled", () => {
    const chunks: string[] = [];
    const stream = { write: (c: string) => chunks.push(c), columns: 100, isTTY: true };

    const bar = createProgress({
      label: "Parsing commits",
      total: 2,
      enabled: true,
      stream,
    });
    bar.increment("abc12345");
    bar.increment("def67890");
    bar.done();
    bar.done(); // idempotent
    bar.clear(); // no-op after done

    expect(chunks.some((c) => /Parsing commits \[.+\] 1\/2 \(50%\) \| [\d.]+s \| abc12345/.test(c))).toBe(true);
    expect(chunks.some((c) => /Parsing commits \[.+\] 2\/2 \(100%\) \| [\d.]+s \| def67890/.test(c))).toBe(true);
    const last = chunks[chunks.length - 1];
    expect(last.startsWith("Parsing commits (2/2,")).toBe(true);
    expect(last.endsWith("\n")).toBe(true);
  });

  test("clear stops the bar and is idempotent", () => {
    const chunks: string[] = [];
    const stream = { write: (c: string) => chunks.push(c), columns: 80, isTTY: true };

    const bar = createProgress({
      label: "Validating",
      total: 5,
      enabled: true,
      stream,
    });
    expect(chunks.some((c) => /Validating \[.+\] 0\/5 \(0%\) \| [\d.]+s/.test(c))).toBe(true);
    const beforeClear = chunks.length;
    bar.clear();
    const afterClear = chunks.length;
    bar.done(); // no-op after clear

    expect(afterClear).toBeGreaterThan(beforeClear);
    expect(chunks.length).toBe(afterClear);
  });

  test("done accepts optional detail metadata", () => {
    const chunks: string[] = [];
    const stream = { write: (c: string) => chunks.push(c), columns: 100, isTTY: true };

    const bar = createProgress({
      label: "Translating",
      total: 10,
      enabled: true,
      stream,
    });
    bar.update(10, "batch 1 | 1.5k tokens | Chapter 1");
    bar.done({ detail: "1.5k tokens" });

    const last = chunks[chunks.length - 1];
    expect(last.startsWith("Translating (10/10, 1.5k tokens, ")).toBe(true);
    expect(last.endsWith("\n")).toBe(true);
  });
});

describe("formatCompactCount and formatLlmTokens", () => {
  test("formats compact counts across small, k, and M ranges", () => {
    expect(formatCompactCount(0)).toBe("0");
    expect(formatCompactCount(845)).toBe("845");
    expect(formatCompactCount(1_000)).toBe("1.0k");
    expect(formatCompactCount(1_420)).toBe("1.4k");
    expect(formatCompactCount(1_250_000)).toBe("1.25M");
  });

  test("formats estimated (~) vs exact token counts and never shows chars", () => {
    expect(formatLlmTokens({ tokens: 0, exact: false })).toBe("0 tokens");
    expect(formatLlmTokens({ tokens: 0, exact: true })).toBe("0 tokens");
    expect(formatLlmTokens({ tokens: 850, exact: false })).toBe("~850 tokens");
    expect(formatLlmTokens({ tokens: 1_420, exact: false })).toBe("~1.4k tokens");
    expect(formatLlmTokens({ tokens: 1_420, exact: true })).toBe("1.4k tokens");
  });

  test("formats uploading, waiting, streaming, and finished LLM progress with tok/s", () => {
    expect(formatTokPerSec(68.54)).toBe("68.5 tok/s");

    expect(
      formatLlmProgress({
        phase: "uploading",
        inputTokens: 14_200,
        exactInput: false,
        outputTokens: 0,
        exactOutput: false,
      }),
    ).toBe("↑ ~14.2k tokens (uploading)");

    expect(
      formatLlmProgress({
        phase: "waiting",
        inputTokens: 14_200,
        exactInput: false,
        outputTokens: 0,
        exactOutput: false,
      }),
    ).toBe("↑ ~14.2k tokens (waiting)");

    expect(
      formatLlmProgress({
        phase: "stream",
        inputTokens: 14_200,
        exactInput: false,
        outputTokens: 420,
        exactOutput: false,
      }),
    ).toBe("↑ ~14.2k ↓ ~420 tokens");

    expect(
      formatLlmProgress({
        phase: "stream",
        inputTokens: 14_200,
        exactInput: false,
        outputTokens: 420,
        exactOutput: false,
        tokPerSec: 68.5,
      }),
    ).toBe("↑ ~14.2k ↓ ~420 tokens (68.5 tok/s)");

    expect(
      formatLlmProgress({
        phase: "finish",
        inputTokens: 13_900,
        exactInput: true,
        outputTokens: 1_500,
        exactOutput: true,
        tokPerSec: 71.2,
      }),
    ).toBe("↑ 13.9k ↓ 1.5k tokens (71.2 tok/s)");
  });
});

describe("createTranslateProgress", () => {
  test("is a no-op when disabled or total is 0", () => {
    const chunks: string[] = [];
    const stream = { write: (c: string) => chunks.push(c), columns: 100, isTTY: true };

    const disabled = createTranslateProgress({
      label: "Translating",
      total: 10,
      concurrency: 3,
      enabled: false,
      stream,
    });
    disabled.setPages(1, 2);
    disabled.setWorker(0, { documentTitle: "Ch 1", unitCount: 3, progress: null });
    disabled.update(5);
    disabled.clearWorker(0);
    disabled.done();
    expect(chunks).toEqual([]);

    const empty = createTranslateProgress({
      label: "Translating",
      total: 0,
      concurrency: 3,
      enabled: true,
      stream,
    });
    empty.setWorker(0, { documentTitle: "Ch 1", unitCount: 3, progress: null });
    empty.done();
    expect(chunks).toEqual([]);
  });

  test("renders 1 + concurrency lines, tracks actives, truncates long lines, and emits summary on done", () => {
    const chunks: string[] = [];
    const bar = createTranslateProgress({
      label: "Translating",
      total: 10,
      concurrency: 3,
      totalPages: 4,
      enabled: true,
      stream: { write: (c: string) => chunks.push(c), columns: 140, isTTY: true },
    });

    // Initial frame shows 1 + 3 lines with all workers idle
    expect(chunks).toHaveLength(1);
    const initialLines = chunks[0]!.split("\n");
    expect(initialLines).toHaveLength(4);
    expect(initialLines[0]).toMatch(
      /Translating \[░{20}\] 0\/10 \(0%\) \| 0 actives \| 0 \/ 4 Pages \| [\d.]+s/,
    );
    expect(initialLines[1]).toContain("Worker #1 | idle");
    expect(initialLines[2]).toContain("Worker #2 | idle");
    expect(initialLines[3]).toContain("Worker #3 | idle");

    bar.setWorker(0, {
      documentTitle: "RV32I Base Integer Instruction Set",
      unitCount: 5,
      progress: {
        phase: "stream",
        inputTokens: 1200,
        exactInput: false,
        outputTokens: 300,
        exactOutput: false,
        tokPerSec: 45.2,
      },
    });
    bar.setWorker(1, {
      documentTitle: "Zicsr Control",
      unitCount: 4,
      progress: {
        phase: "waiting",
        inputTokens: 900,
        exactInput: false,
        outputTokens: 0,
        exactOutput: false,
      },
    });

    const activeFrame = chunks[chunks.length - 1]!;
    expect(activeFrame).toMatch(/\| 2 actives \| 0 \/ 4 Pages \| [\d.]+s/);
    expect(activeFrame).toMatch(
      /Worker #1 \| ↑ ~1\.2k ↓ ~300 \| 45\.2 t\/s \| 5 Units \| [\d.]+s \| RV32I Base Integer Instruction Set/,
    );
    expect(activeFrame).toMatch(
      /Worker #2 \| ↑ ~900 ↓ 0 \| waiting \| 4 Units \| [\d.]+s \| Zicsr Control/,
    );
    expect(activeFrame).toContain("Worker #3 | idle");

    bar.update(5, { donePages: 1, totalPages: 4 });
    bar.clearWorker(1);
    const afterClearFrame = chunks[chunks.length - 1]!;
    expect(afterClearFrame).toMatch(/5\/10 \(50%\) \| 1 actives \| 1 \/ 4 Pages \| [\d.]+s/);
    expect(afterClearFrame).toContain("Worker #2 | idle");

    bar.update(10, { donePages: 4, totalPages: 4 });
    bar.clearWorker(0);
    bar.done({ detail: "↑ 2.1k ↓ 1.2k tokens" });
    expect(chunks[chunks.length - 2]).toContain("\x1b[3A\r\x1b[0J");
    expect(chunks[chunks.length - 1]).toMatch(/^Translating \(10\/10, ↑ 2\.1k ↓ 1\.2k tokens, .+\)\n$/);

    // Column width truncation keeps every rendered line within maxCols so terminals never soft-wrap
    const narrowChunks: string[] = [];
    const narrowBar = createTranslateProgress({
      label: "Translating",
      total: 10,
      concurrency: 2,
      totalPages: 2,
      enabled: true,
      stream: { write: (c: string) => narrowChunks.push(c), columns: 50, isTTY: true },
    });
    narrowBar.setWorker(0, {
      documentTitle: "Very Long Chapter Title With 中文字符 That Should Truncate Cleanly",
      unitCount: 12,
      progress: {
        phase: "stream",
        inputTokens: 5000,
        exactInput: false,
        outputTokens: 800,
        exactOutput: false,
        tokPerSec: 32.1,
      },
    });
    const narrowFrame = narrowChunks[narrowChunks.length - 1]!;
    // Strip leading cursor control & trailing \x1b[K before measuring visual width per line
    const visualLines = narrowFrame
      .replace(/^\r/, "")
      .replace(/^(?:\x1b\[\d+A)?\r/, "")
      .split("\n")
      .map((l) => l.replace(/\x1b\[K$/, ""));
    expect(visualLines).toHaveLength(3);
    for (const line of visualLines) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(50);
    }
    expect(visualLines[1]!.endsWith("…")).toBe(true);
    narrowBar.clear();
  });
});

describe("CI summary progress mode", () => {
  const spies: Array<{ mockRestore(): void }> = [];

  const captureCiLogs = () => {
    const logged: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    const successImpl = Object.assign(
      (msg: unknown) => {
        logged.push(String(msg));
      },
      { raw: () => {} },
    );
    const loggerSpy = spyOn(logger, "success").mockImplementation(successImpl);
    spies.push(stderrSpy, loggerSpy);
    return { logged, stderrSpy };
  };

  afterEach(() => {
    while (spies.length > 0) {
      spies.pop()!.mockRestore();
    }
  });

  test("createProgress stays silent on updates and emits one summary line on done in CI", () => {
    const { logged, stderrSpy } = captureCiLogs();

    const bar = createProgress({
      label: "Parsing commits",
      total: 4,
      env: { CI: "true" },
    });
    bar.update(1, "commit 1");
    bar.increment("commit 2");
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(logged).toEqual([]);

    bar.done({ detail: "cached" });
    bar.done(); // idempotent
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^Parsing commits \(2\/4, cached, [\d.]+s\)$/);

    // clear() produces no output
    const cleared = createProgress({
      label: "Cleared",
      total: 3,
      env: { GITHUB_ACTIONS: "true" },
    });
    cleared.increment();
    cleared.clear();
    cleared.done();
    expect(logged).toHaveLength(1);
  });

  test("createTranslateProgress stays silent on worker updates and emits one summary line on done in CI", () => {
    const { logged, stderrSpy } = captureCiLogs();

    const bar = createTranslateProgress({
      label: "Translating",
      total: 10,
      concurrency: 3,
      totalPages: 2,
      env: { CI: "true" },
    });
    bar.setPages(1, 2);
    bar.setWorker(0, { documentTitle: "RV32I", unitCount: 5, progress: null });
    bar.update(5, { donePages: 1, totalPages: 2 });
    bar.clearWorker(0);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(logged).toEqual([]);

    bar.done({ detail: "↑ 1.2k ↓ 400 tokens" });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^Translating \(5\/10, ↑ 1\.2k ↓ 400 tokens, [\d.]+s\)$/);
  });
});
