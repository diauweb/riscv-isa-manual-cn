import { describe, expect, it } from "bun:test";
import { buildCompareRows } from "../src/utils/diff";
import type { RenderedUnit, ResolvedChapter } from "../src/types";

function makePara(unitId: string, enText: string, zhText = "译文"): RenderedUnit {
  return {
    unit_id: unitId,
    kind: "paragraph",
    translatable: true,
    status: "approved",
    en_html: `<p>${enText}</p>`,
    zh_html: `<p>${zhText}</p>`,
  };
}

function makeHeading(unitId: string, level: number, enText: string, zhText: string): RenderedUnit {
  return {
    unit_id: unitId,
    kind: "heading",
    translatable: true,
    status: "approved",
    en_html: `<h${level}>${enText}</h${level}>`,
    zh_html: `<h${level}>${zhText}</h${level}>`,
  };
}

function makeChapter(
  sections: ResolvedChapter["sections"],
  units: Record<string, RenderedUnit>,
): ResolvedChapter {
  return {
    struct_hash: "s1",
    pack_hash: "p1",
    volume_id: "unpriv",
    chapter_id: "rv32i",
    sectname: "chapter",
    sectnum: "1",
    title_en: "RV32I",
    title_zh: "RV32I",
    sections,
    units,
  };
}

describe("buildCompareRows multi-hop alignment and explicit headings", () => {
  it("renders explicit section headings via heading_unit_id and opensSection flag", () => {
    const h1 = "10000000000000000000000000000001";
    const p1 = "20000000000000000000000000000001";
    const base = makeChapter(
      [
        {
          id: "sec-1",
          level: 1,
          sectnum: "1",
          title_en: "Intro",
          title_zh: "引言",
          heading_unit_id: h1,
          blocks: [p1],
        },
      ],
      {
        [h1]: makeHeading(h1, 1, "Intro", "引言"),
        [p1]: makePara(p1, "Initial sentence."),
      },
    );
    const target = makeChapter(
      [
        {
          id: "sec-1",
          level: 1,
          sectnum: "1",
          title_en: "Intro",
          title_zh: "引言",
          heading_unit_id: h1,
          blocks: [p1],
        },
      ],
      {
        [h1]: makeHeading(h1, 1, "Intro", "引言"),
        [p1]: makePara(p1, "Initial sentence."),
      },
    );

    const rows = buildCompareRows(base, target);
    expect(rows).toHaveLength(2);
    expect(rows[0].opensSection).toBe(true);
    expect(rows[0].targetBlock?.kind).toBe("heading");
    expect(rows[0].changeKind).toBe("unchanged");
    expect(rows[1].opensSection).toBeFalsy();
    expect(rows[1].unitId).toBe(p1);
  });

  it("pairs multi-hop modified units via lineageMap in both forward and reverse directions", () => {
    const v1 = "aaaa0000000000000000000000000001";
    const v2 = "aaaa0000000000000000000000000002";
    const v3 = "aaaa0000000000000000000000000003";

    const v1Chap = makeChapter(
      [
        {
          id: "sec-a",
          level: 2,
          sectnum: "1.1",
          title_en: "Registers",
          title_zh: "寄存器",
          blocks: [v1],
        },
      ],
      {
        [v1]: makePara(v1, "Completely short alpha text."),
      },
    );
    const v3Chap = makeChapter(
      [
        {
          id: "sec-a",
          level: 2,
          sectnum: "1.1",
          title_en: "Registers",
          title_zh: "寄存器",
          blocks: [v3],
        },
      ],
      {
        [v3]: makePara(
          v3,
          "Extensively rewritten register specification for base integer instruction execution.",
        ),
      },
    );

    const lineageMap = new Map<string, string | undefined>([
      [v2, v1],
      [v3, v2],
    ]);

    const forwardRows = buildCompareRows(v1Chap, v3Chap, lineageMap);
    expect(forwardRows).toHaveLength(1);
    expect(forwardRows[0].changeKind).toBe("modified");
    expect(forwardRows[0].baseBlock?.unit_id).toBe(v1);
    expect(forwardRows[0].targetBlock?.unit_id).toBe(v3);

    const reverseRows = buildCompareRows(v3Chap, v1Chap, lineageMap);
    expect(reverseRows).toHaveLength(1);
    expect(reverseRows[0].changeKind).toBe("modified");
    expect(reverseRows[0].baseBlock?.unit_id).toBe(v3);
    expect(reverseRows[0].targetBlock?.unit_id).toBe(v1);
  });

  it("detects cross-section moved units and falls back to token-Jaccard >= 0.60 when lineage is absent", () => {
    const movedId = "bbbb0000000000000000000000000001";
    const j1 = "cccc0000000000000000000000000001";
    const j2 = "cccc0000000000000000000000000002";

    const base = makeChapter(
      [
        {
          id: "sec-old",
          level: 2,
          sectnum: "1.1",
          title_en: "Old Section",
          title_zh: "旧小节",
          blocks: [movedId, j1],
        },
        {
          id: "sec-new",
          level: 2,
          sectnum: "1.2",
          title_en: "New Section",
          title_zh: "新小节",
          blocks: [],
        },
      ],
      {
        [movedId]: makePara(movedId, "Stable paragraph moved between sections."),
        [j1]: makePara(j1, "The ADDI instruction adds the sign-extended immediate to register rs1."),
      },
    );

    const target = makeChapter(
      [
        {
          id: "sec-old",
          level: 2,
          sectnum: "1.1",
          title_en: "Old Section",
          title_zh: "旧小节",
          blocks: [j2],
        },
        {
          id: "sec-new",
          level: 2,
          sectnum: "1.2",
          title_en: "New Section",
          title_zh: "新小节",
          blocks: [movedId],
        },
      ],
      {
        [movedId]: makePara(movedId, "Stable paragraph moved between sections."),
        [j2]: makePara(
          j2,
          "The ADDI instruction adds the sign-extended 12-bit immediate to register rs1.",
        ),
      },
    );

    const rows = buildCompareRows(base, target);
    const jaccardRow = rows.find((r) => r.targetBlock?.unit_id === j2);
    expect(jaccardRow?.changeKind).toBe("modified");
    expect(jaccardRow?.baseBlock?.unit_id).toBe(j1);

    const movedRow = rows.find((r) => r.targetBlock?.unit_id === movedId);
    expect(movedRow?.changeKind).toBe("moved");
    expect(movedRow?.movedFromSection).toBe("旧小节");
  });

  it("pairs modified units via RenderedUnit.prev_unit_id without external lineageMap", () => {
    const v1 = "dddd0000000000000000000000000001";
    const v2 = "dddd0000000000000000000000000002";

    const base = makeChapter(
      [
        {
          id: "sec-b",
          level: 2,
          sectnum: "1.2",
          title_en: "Immediate",
          title_zh: "立即数",
          blocks: [v1],
        },
      ],
      {
        [v1]: makePara(v1, "Original short sentence."),
      },
    );
    const target = makeChapter(
      [
        {
          id: "sec-b",
          level: 2,
          sectnum: "1.2",
          title_en: "Immediate",
          title_zh: "立即数",
          blocks: [v2],
        },
      ],
      {
        [v2]: {
          ...makePara(v2, "Significantly expanded replacement wording with different tokens."),
          prev_unit_id: v1,
        },
      },
    );

    const rows = buildCompareRows(base, target);
    expect(rows).toHaveLength(1);
    expect(rows[0].changeKind).toBe("modified");
    expect(rows[0].baseBlock?.unit_id).toBe(v1);
    expect(rows[0].targetBlock?.unit_id).toBe(v2);
  });
});
