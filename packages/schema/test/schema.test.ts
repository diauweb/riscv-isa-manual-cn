import { describe, expect, test } from "bun:test";
import {
  BlockEntrySchema,
  BlockKindSchema,
  BlockRefSchema,
  ChapterStructureSchema,
  DiffStatusSchema,
  DiffSummarySchema,
  Hex16Schema,
  Hex32Schema,
  SnapshotSlotChangeSchema,
  TranslationStatusSchema,
  UnitTomlSchema,
  UpstreamChangeKindSchema,
  VolumeIdSchema,
  blockEntryUnitId,
  compactBlockEntry,
  isDefaultTranslatableKind,
  normalizeBlockEntry,
} from "../src/index.ts";

const HEX_A = "0123456789abcdef0123456789abcdef";
const HEX_B = "fedcba9876543210fedcba9876543210";
const HEX16_A = "0123456789abcdef";

describe("Hex schemas", () => {
  test("Hex32Schema accepts 32-char lowercase hex and rejects invalid", () => {
    expect(Hex32Schema.parse(HEX_A)).toBe(HEX_A);
    expect(() => Hex32Schema.parse(HEX_A.toUpperCase())).toThrow();
    expect(() => Hex32Schema.parse(HEX_A.slice(0, 31))).toThrow();
    expect(() => Hex32Schema.parse(`${HEX_A}0`)).toThrow();
    expect(() => Hex32Schema.parse("g".repeat(32))).toThrow();
  });

  test("Hex16Schema accepts 16-char lowercase hex and rejects invalid", () => {
    expect(Hex16Schema.parse(HEX16_A)).toBe(HEX16_A);
    expect(() => Hex16Schema.parse(HEX16_A.toUpperCase())).toThrow();
    expect(() => Hex16Schema.parse(HEX16_A.slice(0, 15))).toThrow();
  });
});

describe("Enum schemas", () => {
  test("BlockKindSchema and isDefaultTranslatableKind", () => {
    for (const kind of [
      "heading",
      "paragraph",
      "list",
      "table",
      "block",
      "code",
      "diagram",
      "math",
    ] as const) {
      expect(BlockKindSchema.parse(kind)).toBe(kind);
    }
    expect(() => BlockKindSchema.parse("image")).toThrow();
    expect(isDefaultTranslatableKind("paragraph")).toBe(true);
    expect(isDefaultTranslatableKind("heading")).toBe(true);
    expect(isDefaultTranslatableKind("code")).toBe(false);
    expect(isDefaultTranslatableKind("diagram")).toBe(false);
    expect(isDefaultTranslatableKind("math")).toBe(false);
  });

  test("TranslationStatusSchema enforces 3 states", () => {
    for (const status of ["untranslated", "machine", "approved"] as const) {
      expect(TranslationStatusSchema.parse(status)).toBe(status);
    }
    expect(() => TranslationStatusSchema.parse("draft")).toThrow();
    expect(() => TranslationStatusSchema.parse("unknown")).toThrow();
  });

  test("DiffStatusSchema & UpstreamChangeKindSchema & VolumeIdSchema", () => {
    for (const status of ["added", "modified", "moved"] as const) {
      expect(DiffStatusSchema.parse(status)).toBe(status);
    }
    expect(() => DiffStatusSchema.parse("unchanged")).toThrow();
    expect(() => DiffStatusSchema.parse("deleted")).toThrow();

    for (const ck of ["baseline", "added", "modified", "moved"] as const) {
      expect(UpstreamChangeKindSchema.parse(ck)).toBe(ck);
    }
    for (const id of ["unpriv", "priv", "profiles", "debug"] as const) {
      expect(VolumeIdSchema.parse(id)).toBe(id);
    }
    expect(() => VolumeIdSchema.parse("other")).toThrow();
  });
});

describe("Strict discriminated UnitTomlSchema", () => {
  test("accepts valid translatable and untranslatable units", () => {
    expect(
      UnitTomlSchema.parse({
        unit_id: HEX_A,
        kind: "paragraph",
        translatable: true,
        status: "untranslated",
        en: "Hello world.",
        zh: "",
      }).translatable,
    ).toBe(true);

    expect(
      UnitTomlSchema.parse({
        unit_id: HEX_A,
        kind: "heading",
        translatable: true,
        status: "machine",
        en: "Overview",
        zh: "概述",
      }).translatable,
    ).toBe(true);

    expect(
      UnitTomlSchema.parse({
        unit_id: HEX_A,
        kind: "table",
        translatable: true,
        status: "approved",
        en: "|===\n| A\n|===",
        zh: "|===\n| 甲\n|===",
      }).translatable,
    ).toBe(true);

    expect(
      UnitTomlSchema.parse({
        unit_id: HEX_B,
        kind: "code",
        translatable: false,
        en: "addi x1, x0, 1",
      }).translatable,
    ).toBe(false);
  });

  test("rejects status/zh on untranslatable, invalid zh/status pairs, invalid statuses, and extra fields", () => {
    expect(() =>
      UnitTomlSchema.parse({
        unit_id: HEX_B,
        kind: "code",
        translatable: false,
        status: "approved",
        en: "addi x1, x0, 1",
        zh: "addi x1, x0, 1",
      }),
    ).toThrow();

    expect(() =>
      UnitTomlSchema.parse({
        unit_id: HEX_A,
        kind: "paragraph",
        translatable: true,
        status: "draft",
        en: "a",
        zh: "甲",
      }),
    ).toThrow();

    expect(() =>
      UnitTomlSchema.parse({
        unit_id: HEX_A,
        kind: "paragraph",
        translatable: true,
        status: "machine",
        en: "a",
        zh: "   ",
      }),
    ).toThrow();

    expect(() =>
      UnitTomlSchema.parse({
        unit_id: HEX_A,
        kind: "paragraph",
        translatable: true,
        status: "untranslated",
        en: "a",
        zh: "不应有译文",
      }),
    ).toThrow();

    expect(() =>
      UnitTomlSchema.parse({
        unit_id: HEX_A,
        kind: "paragraph",
        translatable: true,
        extra_field: "unexpected",
        status: "machine",
        en: "a",
        zh: "甲",
      }),
    ).toThrow();
  });
});

describe("Manifest, compaction, and strict site structure rules", () => {
  test("BlockRefSchema enforces strict fields", () => {
    expect(BlockRefSchema.parse({ unit_id: HEX_A })).toEqual({ unit_id: HEX_A });
    expect(() => BlockRefSchema.parse({ unit_id: HEX_A, level: 2 })).toThrow();
  });

  test("BlockEntrySchema compaction and normalization", () => {
    expect(BlockEntrySchema.parse(HEX_A)).toBe(HEX_A);
    expect(BlockEntrySchema.parse({ unit_id: HEX_A, anchor_id: "norm:a" })).toEqual({
      unit_id: HEX_A,
      anchor_id: "norm:a",
    });
    expect(BlockEntrySchema.parse({ unit_id: HEX_A, extra_anchors: ["alt-a"] })).toEqual({
      unit_id: HEX_A,
      extra_anchors: ["alt-a"],
    });
    expect(() => BlockEntrySchema.parse({ unit_id: HEX_A })).toThrow();
    expect(() => BlockEntrySchema.parse({ unit_id: HEX_A, extra_anchors: [] })).toThrow();

    expect(blockEntryUnitId(HEX_A)).toBe(HEX_A);
    expect(blockEntryUnitId({ unit_id: HEX_B, anchor_id: "x" })).toBe(HEX_B);
    expect(normalizeBlockEntry(HEX_A)).toEqual({ unit_id: HEX_A });
    expect(compactBlockEntry({ unit_id: HEX_A })).toBe(HEX_A);
    expect(compactBlockEntry({ unit_id: HEX_A, extra_anchors: [] })).toBe(HEX_A);
    expect(compactBlockEntry({ unit_id: HEX_A, anchor_id: "x" })).toEqual({
      unit_id: HEX_A,
      anchor_id: "x",
    });
  });

  test("DiffSummarySchema rejects negative counts and SnapshotSlotChangeSchema handles numeric and heading slots", () => {
    expect(() =>
      DiffSummarySchema.parse({
        added: -1,
        modified: 0,
        moved: 0,
        deleted: 0,
        touched_chapters: [],
      }),
    ).toThrow();

    expect(
      SnapshotSlotChangeSchema.parse({
        chapter_key: "unpriv/intro",
        section_id: "sec-intro",
        slot: 1,
        unit_id: HEX_A,
        status: "modified",
        prev_unit_id: HEX_B,
      }).slot,
    ).toBe(1);

    expect(
      SnapshotSlotChangeSchema.parse({
        chapter_key: "unpriv/intro",
        section_id: "sec-intro",
        slot: "heading",
        unit_id: HEX_A,
        status: "moved",
        moved_from: "unpriv/old/sec",
      }).slot,
    ).toBe("heading");
  });

  test("ChapterStructureSchema enforces strict omission of snapshot-only diff fields", () => {
    const structure = {
      struct_hash: HEX16_A,
      volume_id: "priv" as const,
      chapter_id: "machine",
      sectname: "chapter",
      sectnum: "3",
      title_en: "Machine-Level ISA",
      title_zh: "机器级指令集架构",
      title_unit_id: HEX_A,
      sections: [
        {
          id: "sec-1",
          level: 1,
          sectnum: "3",
          title_en: "Overview",
          title_zh: "概述",
          heading_unit_id: HEX_A,
          blocks: [HEX_B, { unit_id: HEX_A, anchor_id: "note-a" }],
        },
      ],
    };
    expect(ChapterStructureSchema.parse(structure)).toEqual(structure);
    expect(() =>
      ChapterStructureSchema.parse({
        ...structure,
        sections: [{ ...structure.sections[0], heading_diff_status: "modified" }],
      }),
    ).toThrow();
  });
});
