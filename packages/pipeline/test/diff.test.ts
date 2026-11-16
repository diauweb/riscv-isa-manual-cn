import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { VolumeNode } from "@riscv-cn/schema";
import {
  classifyUpstreamTags,
  diffSnapshots,
} from "../src/diff/index.ts";
import {
  dehydrateSnapshot,
  hydrateSnapshot,
  type HydratedSnapshot,
} from "../src/manifests/index.ts";
import {
  computeUnitId,
  type ExtractedUnit,
  parseRepositorySnapshot,
} from "../src/parser/index.ts";

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "riscv-diff-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeSyntheticSnapshot(
  chapters: Array<{
    id: string;
    source_path?: string;
    sections: Array<{
      id: string;
      blocks: Array<{
        kind?: ExtractedUnit["kind"];
        en: string;
        anchor_id?: string;
      }>;
    }>;
  }>,
): { volumes: VolumeNode[]; units: Map<string, ExtractedUnit> } {
  const units = new Map<string, ExtractedUnit>();
  const vol: VolumeNode = {
    id: "unpriv",
    title_en: "Unprivileged",
    entry_file: "src/riscv-unprivileged.adoc",
    chapters: chapters.map((ch, chIdx) => ({
      id: ch.id,
      sectname: "chapter",
      sectnum: String(chIdx + 1),
      title_en: ch.id,
      source_path: ch.source_path ?? `src/${ch.id}.adoc`,
      sections: ch.sections.map((sec, secIdx) => ({
        id: sec.id,
        level: 2,
        sectnum: `${chIdx + 1}.${secIdx + 1}`,
        title: sec.id,
        blocks: sec.blocks.map((b) => {
          const kind = b.kind ?? "paragraph";
          const unitId = computeUnitId(kind, b.en);
          if (!units.has(unitId)) {
            units.set(unitId, {
              unit_id: unitId,
              kind,
              translatable: true,
              en: b.en,
              ...(b.anchor_id ? { anchor_id: b.anchor_id } : {}),
            });
          }
          return {
            unit_id: unitId,
            ...(b.anchor_id ? { anchor_id: b.anchor_id } : {}),
          };
        }),
      })),
    })),
  };

  return { volumes: [vol], units };
}

describe("classifyUpstreamTags", () => {
  it("classifies YYYYMMDD ratified tags and riscv-isa-release-* draft tags from records and arrays", () => {
    const fromRecord = classifyUpstreamTags({
      aaa111: ["20240411", "v1.0-ignored"],
      bbb222: ["riscv-isa-release-20250101-abc", "riscv-isa-release-20250102-def"],
      ccc333: ["random-tag"],
    });

    expect(fromRecord.get("aaa111")).toEqual({
      ratified_tag: "20240411",
      draft_tags: [],
    });
    expect(fromRecord.get("bbb222")).toEqual({
      ratified_tag: null,
      draft_tags: [
        "riscv-isa-release-20250101-abc",
        "riscv-isa-release-20250102-def",
      ],
    });
    expect(fromRecord.has("ccc333")).toBe(false);

    const fromArray = classifyUpstreamTags([
      { tag: "20240411", sha: "sha1" },
      { tag: "20250508", sha: "sha1" },
      { tag: "riscv-isa-release-rc1", sha: "sha2" },
    ]);
    expect(fromArray.get("sha1")?.ratified_tag).toBe("20250508");
    expect(fromArray.get("sha2")?.draft_tags).toEqual([
      "riscv-isa-release-rc1",
    ]);
  });
});

describe("diffSnapshots", () => {
  it("produces a clean zero-diff baseline when parent is null", () => {
    const child = makeSyntheticSnapshot([
      {
        id: "ch1",
        sections: [
          {
            id: "sec1",
            blocks: [
              { en: "First paragraph." },
              { en: "Second paragraph." },
            ],
          },
        ],
      },
    ]);

    const res = diffSnapshots(null, child);
    expect(res.is_baseline).toBe(true);
    expect(res.diff).toEqual({
      added: 0,
      modified: 0,
      moved: 0,
      deleted: 0,
      touched_chapters: [],
    });
    expect(res.deleted_blocks).toEqual([]);
    expect(res.prevUnitMap.size).toBe(0);
    expect(
      res.volumes[0].chapters[0].sections[0].blocks.map((b) => b.diff_status),
    ).toEqual([undefined, undefined]);
  });

  it("locks exact matches first: RV32 (5 bits) unchanged + RV64 (6 bits) added never matches 5 bits to 6 bits", () => {
    const parent = makeSyntheticSnapshot([
      {
        id: "rv32i",
        sections: [
          {
            id: "sec:shifts",
            blocks: [
              {
                en: "In RV32I, the shift amount is encoded in the lower 5 bits of the immediate field.",
              },
            ],
          },
        ],
      },
    ]);

    const child = makeSyntheticSnapshot([
      {
        id: "rv32i",
        sections: [
          {
            id: "sec:shifts",
            blocks: [
              {
                en: "In RV32I, the shift amount is encoded in the lower 5 bits of the immediate field.",
              },
              {
                en: "In RV64I, the shift amount is encoded in the lower 6 bits of the immediate field.",
              },
            ],
          },
        ],
      },
    ]);

    const res = diffSnapshots(parent, child);
    const blocks = res.volumes[0].chapters[0].sections[0].blocks;
    expect(blocks[0].diff_status).toBeUndefined();
    expect(blocks[1].diff_status).toBe("added");
    expect(blocks[1].prev_unit_id).toBeUndefined();
    expect(res.prevUnitMap.size).toBe(0);
    expect(res.diff).toEqual({
      added: 1,
      modified: 0,
      moved: 0,
      deleted: 0,
      touched_chapters: ["unpriv/rv32i"],
    });
  });

  it("produces moved with 0 re-translations on file moves and chapter splits", () => {
    // Case A: chapter split via real AsciiDoc parse
    const repoParent = makeTempRepo();
    fs.mkdirSync(path.join(repoParent, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repoParent, "src/riscv-unprivileged.adoc"),
      `= Manual\n\ninclude::ch1.adoc[]\n`,
    );
    fs.writeFileSync(
      path.join(repoParent, "src/ch1.adoc"),
      `[#ch:base]\n== Base ISA\n\nFirst base rule.\n\n[#sec:atomic]\n=== Atomic Extension\n\nAtomic memory operations execute atomically.\n`,
    );

    const repoChild = makeTempRepo();
    fs.mkdirSync(path.join(repoChild, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repoChild, "src/riscv-unprivileged.adoc"),
      `= Manual\n\ninclude::ch1.adoc[]\n\ninclude::ch_a.adoc[]\n`,
    );
    fs.writeFileSync(
      path.join(repoChild, "src/ch1.adoc"),
      `[#ch:base]\n== Base ISA\n\nFirst base rule.\n`,
    );
    fs.writeFileSync(
      path.join(repoChild, "src/ch_a.adoc"),
      `[#ch:atomic]\n== Atomic Chapter\n\n[#sec:atomic]\n=== Atomic Extension\n\nAtomic memory operations execute atomically.\n`,
    );

    const parentSnap = parseRepositorySnapshot(repoParent);
    const childSnap = parseRepositorySnapshot(repoChild);
    const res = diffSnapshots(parentSnap, childSnap);

    // Moved section heading + moved atomic paragraph (0 modified, 0 deleted)
    // Only the new chapter heading "== Atomic Chapter" is added.
    expect(res.diff.modified).toBe(0);
    expect(res.diff.deleted).toBe(0);
    expect(res.diff.moved).toBe(2);
    expect(res.diff.added).toBe(1);

    const atomicSec = res.volumes[0].chapters[1].sections[1];
    expect(atomicSec.heading_diff_status).toBe("moved");
    expect(atomicSec.heading_moved_from).toBe("unpriv/ch:base/sec:atomic");
    expect(atomicSec.blocks[0].diff_status).toBe("moved");
    expect(atomicSec.blocks[0].moved_from).toBe("unpriv/ch:base/sec:atomic");

    // Case B: file rename keeping chapter/section IDs
    const fileMoveParent = makeSyntheticSnapshot([
      {
        id: "ch:zicsr",
        source_path: "src/zicsr_old.adoc",
        sections: [{ id: "sec:csrs", blocks: [{ en: "CSR instructions." }] }],
      },
    ]);
    const fileMoveChild = makeSyntheticSnapshot([
      {
        id: "ch:zicsr",
        source_path: "src/zicsr_new.adoc",
        sections: [{ id: "sec:csrs", blocks: [{ en: "CSR instructions." }] }],
      },
    ]);
    const fileMoveRes = diffSnapshots(fileMoveParent, fileMoveChild);
    expect(fileMoveRes.diff.moved).toBe(1);
    expect(fileMoveRes.diff.added).toBe(0);
    expect(fileMoveRes.diff.modified).toBe(0);
    expect(
      fileMoveRes.volumes[0].chapters[0].sections[0].blocks[0].diff_status,
    ).toBe("moved");
  });

  it("matches modified blocks via MWBM with >= 0.65 threshold and records prev_unit_id + deleted_blocks", () => {
    const parent = makeSyntheticSnapshot([
      {
        id: "ch1",
        sections: [
          {
            id: "sec1",
            blocks: [
              {
                en: "The rs1 register holds a signed 32-bit integer operand for the ADD instruction.",
              },
              {
                en: "This obsolete note will be completely removed in the next version.",
              },
            ],
          },
        ],
      },
    ]);

    const child = makeSyntheticSnapshot([
      {
        id: "ch1",
        sections: [
          {
            id: "sec1",
            blocks: [
              {
                en: "The rs1 register holds an unsigned 32-bit integer operand for the ADD instruction.",
              },
              {
                en: "Brand new unrelated appendix text about vector cryptographic extensions.",
              },
            ],
          },
        ],
      },
    ]);

    const res = diffSnapshots(parent, child);
    const parentBlocks = parent.volumes[0].chapters[0].sections[0].blocks;
    const childBlocks = res.volumes[0].chapters[0].sections[0].blocks;

    expect(childBlocks[0].diff_status).toBe("modified");
    expect(childBlocks[0].prev_unit_id).toBe(parentBlocks[0].unit_id);
    expect(res.prevUnitMap.get(childBlocks[0].unit_id)).toBe(
      parentBlocks[0].unit_id,
    );

    expect(childBlocks[1].diff_status).toBe("added");
    expect(res.deleted_blocks).toEqual([
      {
        chapter_key: "unpriv/ch1",
        section_id: "sec1",
        after_unit_id: parentBlocks[0].unit_id,
        unit_id: parentBlocks[1].unit_id,
      },
    ]);
    expect(res.diff).toEqual({
      added: 1,
      modified: 1,
      moved: 0,
      deleted: 1,
      touched_chapters: ["unpriv/ch1"],
    });
  });

  it("uses globally optimal 1-to-1 MWBM rather than suboptimal greedy pairing", () => {
    // P0 matches C0 strongly (0.9) and C1 moderately (0.85)
    // P1 matches C0 moderately (0.78) and doesn't match C1 (< 0.65)
    // Optimal total weight pairs (P0 <-> C1) + (P1 <-> C0) = 0.85 + 0.78 = 1.63
    // rather than greedy (P0 <-> C0) = 0.90 leaving P1 and C1 unmatched!
    const parent = makeSyntheticSnapshot([
      {
        id: "ch1",
        sections: [
          {
            id: "sec1",
            blocks: [
              {
                en: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda",
              },
              {
                en: "alpha beta gamma delta epsilon zeta eta theta mu nu xi",
              },
            ],
          },
        ],
      },
    ]);
    const child = makeSyntheticSnapshot([
      {
        id: "ch1",
        sections: [
          {
            id: "sec1",
            blocks: [
              {
                en: "alpha beta gamma delta epsilon zeta eta theta mu nu omicron",
              },
              {
                en: "alpha beta gamma delta epsilon zeta eta theta iota kappa rho",
              },
            ],
          },
        ],
      },
    ]);

    const res = diffSnapshots(parent, child);
    const pBlocks = parent.volumes[0].chapters[0].sections[0].blocks;
    const cBlocks = res.volumes[0].chapters[0].sections[0].blocks;

    expect(res.diff.modified).toBe(2);
    expect(res.diff.added).toBe(0);
    expect(res.diff.deleted).toBe(0);
    expect(cBlocks[0].prev_unit_id).toBe(pBlocks[1].unit_id);
    expect(cBlocks[1].prev_unit_id).toBe(pBlocks[0].unit_id);
  });

  it("dehydrates and re-hydrates snapshots losslessly, including duplicate unit_ids in one section", () => {
    const parent = makeSyntheticSnapshot([
      {
        id: "ch1",
        sections: [
          {
            id: "sec1",
            blocks: [{ en: "Repeated sentence." }],
          },
        ],
      },
    ]);
    const child = makeSyntheticSnapshot([
      {
        id: "ch1",
        sections: [
          {
            id: "sec1",
            blocks: [
              { en: "Repeated sentence." },
              { en: "Repeated sentence." },
            ],
          },
        ],
      },
    ]);

    const res = diffSnapshots(parent, child);
    const hydrated: HydratedSnapshot = {
      sha: "childsha0001",
      parent_sha: "parentsha001",
      is_baseline: res.is_baseline,
      date: "2026-01-02T00:00:00Z",
      title: "Add duplicate block",
      ratified_tag: null,
      draft_tags: [],
      diff: res.diff,
      deleted_blocks: res.deleted_blocks,
      volumes: res.volumes,
    };

    const { snapshot, chapters } = dehydrateSnapshot(hydrated);
    expect(snapshot.changes).toHaveLength(1);
    expect(snapshot.changes[0]).toMatchObject({
      chapter_key: "unpriv/ch1",
      section_id: "sec1",
      slot: 1,
      status: "added",
    });

    const chap = chapters.get(snapshot.volumes[0].chapters[0].chap_hash)!;
    expect(typeof chap.sections[0].blocks[0]).toBe("string");
    expect(typeof chap.sections[0].blocks[1]).toBe("string");

    const roundTripped = hydrateSnapshot(snapshot, (h) => chapters.get(h)!);
    expect(roundTripped).toEqual(hydrated);
  });
});
