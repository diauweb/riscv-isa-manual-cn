import { describe, expect, it } from "bun:test";
import type { UnitToml } from "@riscv-cn/schema";
import { parseUnitToml, serializeUnitToml, unitRelPath } from "../src/toml/index.ts";

const SAMPLE_ID = "0123456789abcdef0123456789abcdef";

describe("toml", () => {
  it("computes deterministic shard relative paths", () => {
    expect(unitRelPath(SAMPLE_ID)).toBe(`units/01/${SAMPLE_ID}.toml`);
  });

  it("serializes and round-trips AsciiDoc tables and LaTeX math using multi-line literal strings", () => {
    const unit: UnitToml = {
      unit_id: SAMPLE_ID,
      kind: "table",
      translatable: true,
      status: "machine",
      en: [
        "|===",
        "| Register | Formula",
        "| `x1` | latexmath:[\\frac{a}{b} + \\sqrt{x}]",
        "|===",
      ].join("\n"),
      zh: [
        "|===",
        "| 寄存器 | 公式",
        "| `x1` | latexmath:[\\frac{a}{b} + \\sqrt{x}]",
        "|===",
      ].join("\n"),
    };

    const toml = serializeUnitToml(unit);
    expect(toml).toContain("en = '''\n");
    expect(toml).toContain("zh = '''\n");
    expect(toml).toContain("|===");
    expect(toml).toContain("\\frac{a}{b}");

    const parsed = parseUnitToml(toml);
    expect(parsed).toEqual(unit);
  });

  it("falls back to escaped multi-line basic strings only when text contains triple single quotes", () => {
    const unit: UnitToml = {
      unit_id: SAMPLE_ID,
      kind: "paragraph",
      translatable: true,
      status: "machine",
      en: "Text with ''' triple single quotes and \"double quotes\" and \\backslash.",
      zh: "包含 ''' 三单引号、\"双引号\" 和 \\反斜杠 的文本。",
    };

    const toml = serializeUnitToml(unit);
    expect(toml).toContain('en = """\n');
    expect(toml).toContain('zh = """\n');

    const parsed = parseUnitToml(toml);
    expect(parsed).toEqual(unit);
  });

  it("round-trips untranslatable code units with trailing newlines and apostrophes without status or zh", () => {
    const unit: UnitToml = {
      unit_id: SAMPLE_ID,
      kind: "code",
      translatable: false,
      en: "Ends with apostrophe'\nAnd ends with two apostrophes''",
    };

    const toml = serializeUnitToml(unit);
    expect(toml).not.toContain("status =");
    expect(toml).not.toContain("zh =");
    const parsed = parseUnitToml(toml);
    expect(parsed).toEqual(unit);
  });
});
