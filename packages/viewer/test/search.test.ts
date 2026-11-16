import { describe, expect, test } from "bun:test";
import type { SearchEntry } from "../src/types";
import {
  buildSearchIndex,
  runSearch,
  searchEntryAt,
  tokenizeIndex,
  tokenizeQuery,
} from "../src/lib/search";

describe("viewer search tokenization and cleaning", () => {
  test("tokenizeQuery preserves compound identifiers while tokenizeIndex adds split sub-tokens", () => {
    expect(tokenizeQuery("ADDI")).toEqual(["addi"]);
    expect(tokenizeQuery("czero.eqz")).toEqual(["czero.eqz"]);
    expect(tokenizeQuery("#norm:addi_op")).toEqual(["norm:addi_op"]);
    expect(tokenizeQuery("算术溢出").length).toBeGreaterThanOrEqual(2);

    const idxNorm = tokenizeIndex("norm:addi_op");
    expect(idxNorm).toContain("norm:addi_op");
    expect(idxNorm).toContain("addi_op");
    expect(idxNorm).toContain("addi");
    expect(idxNorm).toContain("op");

    const idxCzero = tokenizeIndex("czero.eqz");
    expect(idxCzero).toEqual(["czero.eqz", "czero", "eqz"]);
  });
});

describe("viewer search ranking and jump targets", () => {
  const entries: SearchEntry[] = [
    {
      unit_id: "00000000000000000000000000000001",
      volume_id: "unpriv",
      chapter_id: "rv32i",
      section_id: "rv32i",
      chapter_title: "RV32I Base Integer Instruction Set",
      chapter_title_zh: "RV32I 基础整数指令集",
      kind: "heading",
      en: "RV32I Base Integer Instruction Set",
      zh: "RV32I 基础整数指令集",
    },
    {
      unit_id: "00000000000000000000000000000002",
      volume_id: "unpriv",
      chapter_id: "rv32i",
      section_id: "integer-reg-imm",
      chapter_title: "RV32I Base Integer Instruction Set",
      chapter_title_zh: "RV32I 基础整数指令集",
      section_title: "Integer Register-Immediate Instructions",
      section_title_zh: "整数寄存器-立即数指令",
      kind: "paragraph",
      en: "ADDI adds the sign-extended 12-bit immediate to register rs1. Arithmetic overflow is ignored.",
      zh: "ADDI 将符号扩展后的 12 位立即数与寄存器 rs1 相加。算术溢出将被忽略。",
      symbols: ["ADDI", "rs1"],
      anchor_id: "norm:addi_op",
    },
    {
      unit_id: "00000000000000000000000000000003",
      volume_id: "unpriv",
      chapter_id: "rv32i",
      section_id: "integer-reg-imm",
      chapter_title: "RV32I Base Integer Instruction Set",
      chapter_title_zh: "RV32I 基础整数指令集",
      section_title: "Integer Register-Immediate Instructions",
      section_title_zh: "整数寄存器-立即数指令",
      kind: "block",
      en: "ADDI rd, rs1, 0 is used to implement the MV pseudoinstruction.",
      zh: "ADDI rd, rs1, 0 用于实现 MV 伪指令。",
      symbols: ["ADDI", "MV"],
      anchor_id: "norm:add_ovf",
    },
    {
      unit_id: "00000000000000000000000000000004",
      volume_id: "unpriv",
      chapter_id: "rv32i",
      section_id: "integer-reg-imm",
      chapter_title: "RV32I Base Integer Instruction Set",
      chapter_title_zh: "RV32I 基础整数指令集",
      section_title: "Integer Register-Immediate Instructions",
      section_title_zh: "整数寄存器-立即数指令",
      kind: "code",
      en: "addi a0, a1, 4\naddi a0, a0, 1",
      zh: "addi a0, a1, 4\naddi a0, a0, 1",
    },
    {
      unit_id: "00000000000000000000000000000005",
      volume_id: "unpriv",
      chapter_id: "zicond",
      section_id: "insns-czero",
      chapter_title: "Integer Conditional Operations",
      chapter_title_zh: "整数条件操作",
      section_title: "CZERO.EQZ",
      section_title_zh: "CZERO.EQZ",
      kind: "heading",
      en: "czero.eqz",
      zh: "czero.eqz",
      extra_anchors: ["insns-czero-eqz"],
    },
    {
      unit_id: "00000000000000000000000000000006",
      volume_id: "priv",
      chapter_id: "machine",
      section_id: "machine-csrs",
      chapter_title: "Machine-Level ISA",
      chapter_title_zh: "机器模式架构",
      section_title: "Machine Status Registers",
      section_title_zh: "机器状态寄存器",
      kind: "table",
      en: "CSR · Description — mstatus · Machine status register",
      zh: "CSR · 描述 — mstatus · 机器状态寄存器",
      symbols: ["mstatus"],
    },
  ];

  const index = buildSearchIndex(entries);

  test("ranks normative definition above notes and dampens code blocks", () => {
    const addiHits = runSearch(index, "addi");
    expect(addiHits.length).toBeGreaterThanOrEqual(3);
    expect(addiHits[0].unit_id).toBe("00000000000000000000000000000002");
    expect(addiHits[addiHits.length - 1].kind).toBe("code");
  });

  test("matches compound instructions, sub-tokens, anchors, CSRs, and CJK queries", () => {
    expect(runSearch(index, "czero.eqz")[0]?.unit_id).toBe("00000000000000000000000000000005");
    expect(runSearch(index, "eqz")[0]?.unit_id).toBe("00000000000000000000000000000005");
    expect(runSearch(index, "norm:addi_op")[0]?.unit_id).toBe("00000000000000000000000000000002");
    expect(runSearch(index, "#norm:addi_op")[0]?.unit_id).toBe("00000000000000000000000000000002");
    expect(runSearch(index, "addi_op")[0]?.unit_id).toBe("00000000000000000000000000000002");
    expect(runSearch(index, "mstatus")[0]?.unit_id).toBe("00000000000000000000000000000006");
    expect(runSearch(index, "算术溢出")[0]?.unit_id).toBe("00000000000000000000000000000002");
  });

  test("searchEntryAt chooses chapter top, section id, anchor id, or unit fallback", () => {
    expect(searchEntryAt(entries[0])).toBeUndefined();
    expect(searchEntryAt(entries[4])).toBe("insns-czero");
    expect(searchEntryAt(entries[1])).toBe("norm:addi_op");
    expect(searchEntryAt(entries[3])).toBe("u-000000000000");
  });
});
