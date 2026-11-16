import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import Piscina from "piscina";
import type { BlockKind, UnitToml } from "@riscv-cn/schema";
import { parseUnitToml } from "../toml/index.ts";
import type { WorkerTask } from "./worker.ts";

export const MIN_PARALLEL_ITEMS = 64;
export const MIN_PARALLEL_SNAPSHOTS = 4;

/**
 * Default thread count capped at 8: JSC/Opal worker throughput peaks at 8 workers
 * while 16 workers trigger JIT/GC helper thread contention and ~2x RSS bloat.
 */
export function defaultJobs(): number {
  return Math.max(1, Math.min(8, availableParallelism()));
}

/** Splits `items` into contiguous slices of at most `chunkSize` elements. */
export function chunkArray<T>(items: readonly T[], chunkSize: number): T[][] {
  const safeSize = Math.max(1, Math.floor(chunkSize));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) {
    chunks.push(items.slice(i, i + safeSize));
  }
  return chunks;
}

export interface WorkerPool {
  readonly size: number;
  run<T>(taskOrFactory: WorkerTask | ((workerIndex: number) => WorkerTask)): Promise<T>;
  close(): Promise<void>;
}

/**
 * Spawns a fixed `Piscina` worker pool with FIFO slot-index leasing
 * (for e.g. detached git worktrees) and graceful `close()`.
 */
export function createWorkerPool(size: number): WorkerPool {
  const poolSize = Math.max(1, Math.floor(size));
  const piscina = new Piscina({
    filename: new URL("./worker.ts", import.meta.url).href,
    minThreads: poolSize,
    maxThreads: poolSize,
    // Bun's worker_threads can deadlock in Piscina's synchronous Atomics.wait() loop;
    // standard MessagePort dispatch avoids hanging on task completion / close().
    atomics: "disabled",
  });

  const freeSlots = Array.from({ length: poolSize }, (_, i) => i);
  const slotWaiters: Array<{
    resolve: (slot: number) => void;
    reject: (err: Error) => void;
  }> = [];
  let closing = false;
  let closePromise: Promise<void> | null = null;
  let activeTasks = 0;
  const drainWaiters: Array<() => void> = [];

  const runOnPiscina = async <T>(task: WorkerTask): Promise<T> => {
    activeTasks++;
    try {
      return (await piscina.run(task)) as T;
    } finally {
      activeTasks--;
      if (activeTasks === 0) {
        while (drainWaiters.length > 0) {
          drainWaiters.shift()!();
        }
      }
    }
  };

  const acquireSlot = (): Promise<number> => {
    const slot = freeSlots.shift();
    if (slot !== undefined) return Promise.resolve(slot);
    return new Promise<number>((resolve, reject) => {
      slotWaiters.push({ resolve, reject });
    });
  };

  const releaseSlot = (slot: number): void => {
    const waiter = slotWaiters.shift();
    if (waiter) {
      if (closing) {
        waiter.reject(new Error("WorkerPool closed"));
      } else {
        waiter.resolve(slot);
      }
      return;
    }
    freeSlots.push(slot);
  };

  return {
    size: poolSize,

    async run<T>(taskOrFactory: WorkerTask | ((workerIndex: number) => WorkerTask)): Promise<T> {
      if (closing) {
        throw new Error("WorkerPool is closed");
      }
      if (typeof taskOrFactory !== "function") {
        return runOnPiscina<T>(taskOrFactory);
      }
      const slot = await acquireSlot();
      try {
        if (closing) {
          throw new Error("WorkerPool is closed");
        }
        return await runOnPiscina<T>(taskOrFactory(slot));
      } finally {
        releaseSlot(slot);
      }
    },

    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      while (slotWaiters.length > 0) {
        slotWaiters.shift()!.reject(new Error("WorkerPool closed"));
      }
      // Piscina's close() can stall on idle minThreads workers and destroy() awaits once(worker, 'exit'),
      // which Bun's worker.terminate() intermittently skips while port.close() re-refs the worker.
      closePromise = (async () => {
        if (activeTasks > 0) {
          await new Promise<void>((resolve) => drainWaiters.push(resolve));
        }
        const threads = [...piscina.threads];
        const destroyPromise = piscina.destroy();
        const settled = await Promise.race([
          destroyPromise.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 500).unref()),
        ]);
        if (!settled) {
          for (const w of threads) {
            w.unref();
            w.emit("exit", 0);
          }
          await destroyPromise;
        } else {
          for (const w of threads) {
            w.unref();
          }
        }
      })();
      return closePromise;
    },
  };
}

/**
 * Loads and parses unit TOML files in parallel across worker threads when the file
 * count meets `MIN_PARALLEL_ITEMS`, preserving exact input order.
 */
export async function loadUnitsParallel(
  files: string[],
  jobs: number,
  onProgress?: (loadedCount: number) => void,
  sharedPool?: WorkerPool,
): Promise<UnitToml[]> {
  if (files.length === 0) return [];
  if (jobs <= 1 || files.length < MIN_PARALLEL_ITEMS) {
    const out: UnitToml[] = [];
    for (let i = 0; i < files.length; i++) {
      out.push(parseUnitToml(readFileSync(files[i], "utf8")));
      onProgress?.(i + 1);
    }
    return out;
  }

  const chunkSize = Math.max(32, Math.ceil(files.length / (jobs * 4)));
  const chunks = chunkArray(files, chunkSize);
  const ownPool = !sharedPool;
  const pool = sharedPool ?? createWorkerPool(Math.min(jobs, chunks.length));

  try {
    let loaded = 0;
    const chunkResults = await Promise.all(
      chunks.map(async (chunk) => {
        const res = await pool.run<UnitToml[]>({ type: "loadUnitsBatch", files: chunk });
        loaded += chunk.length;
        onProgress?.(loaded);
        return res;
      }),
    );
    return chunkResults.flat();
  } finally {
    if (ownPool) {
      await pool.close();
    }
  }
}

/**
 * Renders AsciiDoc/KaTeX/WaveDrom/Bytefield fragments in parallel across worker threads
 * when `items.length >= MIN_PARALLEL_ITEMS`, preserving exact input order.
 */
export async function renderFragmentsParallel(
  items: Array<{ key: string; text: string; kind: BlockKind }>,
  jobs: number,
  onProgress?: (renderedCount: number) => void,
  sharedPool?: WorkerPool,
): Promise<Array<[string, string]>> {
  if (items.length === 0) return [];
  if (jobs <= 1 || items.length < MIN_PARALLEL_ITEMS) {
    const { renderAdocFragment } = await import("../parser/render.ts");
    const out: Array<[string, string]> = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      out.push([item.key, renderAdocFragment(item.text, item.kind)]);
      onProgress?.(i + 1);
    }
    return out;
  }

  const chunkSize = Math.max(32, Math.ceil(items.length / (jobs * 4)));
  const chunks = chunkArray(items, chunkSize);
  const ownPool = !sharedPool;
  const pool = sharedPool ?? createWorkerPool(Math.min(jobs, chunks.length));

  try {
    let rendered = 0;
    const chunkResults = await Promise.all(
      chunks.map(async (chunk) => {
        const res = await pool.run<Array<[string, string]>>({
          type: "renderBatch",
          items: chunk,
        });
        rendered += chunk.length;
        onProgress?.(rendered);
        return res;
      }),
    );
    return chunkResults.flat();
  } finally {
    if (ownPool) {
      await pool.close();
    }
  }
}
