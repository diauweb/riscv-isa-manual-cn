import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BlockKind, type UnitToml } from "@riscv-cn/schema";
import type { SnapshotInput } from "../diff/index.ts";
import { setVerbosity } from "../log.ts";
import { parseUnitToml } from "../toml/index.ts";
import {
  validateChaptersBatch,
  validateSnapshotsBatch,
  validateUnitsBatch,
} from "../validate/index.ts";

export type WorkerTask =
  | {
      type: "parseSnapshot";
      worktreeDir: string;
      sha: string;
      globalConfigContent: string;
    }
  | {
      type: "renderBatch";
      items: Array<{ key: string; text: string; kind: BlockKind }>;
    }
  | {
      type: "loadUnitsBatch";
      files: string[];
    }
  | {
      type: "validateChaptersBatch";
      files: string[];
      dataDir: string;
    }
  | {
      type: "validateUnitsBatch";
      files: string[];
      dataDir: string;
    }
  | {
      type: "validateSnapshotsBatch";
      files: string[];
      dataDir: string;
    };

export type WorkerMessage =
  | { id: number; task: WorkerTask }
  | { type: "shutdown" };

export type WorkerReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

let snapshotDepsPromise: Promise<{
  parseRepositorySnapshot: typeof import("../parser/index.ts").parseRepositorySnapshot;
  runGitOrThrow: typeof import("../git.ts").runGitOrThrow;
}> | null = null;

function getSnapshotDeps() {
  return (snapshotDepsPromise ??= Promise.all([
    import("../parser/index.ts"),
    import("../git.ts"),
  ]).then(([parser, git]) => ({
    parseRepositorySnapshot: parser.parseRepositorySnapshot,
    runGitOrThrow: git.runGitOrThrow,
  })));
}

let renderFnPromise: Promise<typeof import("../parser/render.ts").renderAdocFragment> | null = null;

function getRenderFn() {
  return (renderFnPromise ??= import("../parser/render.ts").then((m) => m.renderAdocFragment));
}

setVerbosity(0);

export default async function handleTask(task: WorkerTask): Promise<unknown> {
  switch (task.type) {
    case "parseSnapshot": {
      const { parseRepositorySnapshot, runGitOrThrow } = await getSnapshotDeps();
      runGitOrThrow(["checkout", "--force", "--quiet", task.sha], task.worktreeDir);
      const globalCfgPath = join(task.worktreeDir, "docs-resources", "global-config.adoc");
      if (!existsSync(globalCfgPath)) {
        mkdirSync(dirname(globalCfgPath), { recursive: true });
        writeFileSync(globalCfgPath, task.globalConfigContent, "utf8");
      }
      return parseRepositorySnapshot(task.worktreeDir) satisfies SnapshotInput;
    }

    case "renderBatch": {
      const renderAdocFragment = await getRenderFn();
      return task.items.map((item): [string, string] => [
        item.key,
        renderAdocFragment(item.text, item.kind),
      ]);
    }

    case "loadUnitsBatch": {
      return task.files.map((file): UnitToml => parseUnitToml(readFileSync(file, "utf8")));
    }

    case "validateChaptersBatch": {
      return validateChaptersBatch(task.files, task.dataDir);
    }

    case "validateUnitsBatch": {
      return validateUnitsBatch(task.files, task.dataDir);
    }

    case "validateSnapshotsBatch": {
      return validateSnapshotsBatch(task.files, task.dataDir);
    }
  }
}
