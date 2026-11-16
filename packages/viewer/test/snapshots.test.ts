import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  bundleProgress,
  cleanVolumeTitle,
  formatTocChapterTitle,
  shortVolumeLabel,
} from "../src/lib/snapshots";
import { DocBlock } from "../src/components/DocBlock";
import type { RenderedUnit, ResolvedChapter } from "../src/types";

describe("TOC volume & chapter normalization helpers", () => {
  it("strips redundant book and volume prefixes from volume titles and derives short tab labels", () => {
    const unpriv = {
      id: "unpriv" as const,
      title_en: "The RISC-V Instruction Set Manual, Volume I: Unprivileged Architecture",
      title_zh: "RISC-V 指令集手册 第一卷：非特权级架构",
    };
    const priv = {
      id: "priv" as const,
      title_en: "The RISC-V Instruction Set Manual: Volume II: Privileged Architecture",
      title_zh: "RISC-V 指令集手册 第二卷：特权级架构",
    };
    const profiles = {
      id: "profiles" as const,
      title_en: "Volume III: Profiles",
      title_zh: "第三卷：RISC-V 配置集",
    };
    const debug = {
      id: "debug" as const,
      title_en: "Volume IV: Debug and Trace",
      title_zh: "第四卷：调试与跟踪",
    };

    expect(cleanVolumeTitle(unpriv, "zh")).toBe("非特权级架构");
    expect(cleanVolumeTitle(priv, "zh")).toBe("特权级架构");
    expect(cleanVolumeTitle(profiles, "zh")).toBe("RISC-V 配置集");
    expect(cleanVolumeTitle(debug, "zh")).toBe("调试与跟踪");

    expect(cleanVolumeTitle(unpriv, "en")).toBe("Unprivileged Architecture");
    expect(cleanVolumeTitle(priv, "en")).toBe("Privileged Architecture");
    expect(cleanVolumeTitle(profiles, "en")).toBe("Profiles");
    expect(cleanVolumeTitle(debug, "en")).toBe("Debug and Trace");

    expect(shortVolumeLabel(unpriv, "zh")).toBe("I · 非特权级");
    expect(shortVolumeLabel(priv, "zh")).toBe("II · 特权级");
    expect(shortVolumeLabel(profiles, "zh")).toBe("III · 配置集");
    expect(shortVolumeLabel(debug, "zh")).toBe("IV · 调试与跟踪");

    expect(shortVolumeLabel(unpriv, "en")).toBe("I · Unprivileged");
    expect(shortVolumeLabel(priv, "en")).toBe("II · Privileged");
    expect(shortVolumeLabel(profiles, "en")).toBe("III · Profiles");
    expect(shortVolumeLabel(debug, "en")).toBe("IV · Debug and Trace");
  });

  it("cleans inline AsciiDoc backticks, normalizes Chinese quotes, and strips version suffixes for TOC", () => {
    expect(
      formatTocChapterTitle(
        {
          title_en: "`M` Extension for Integer Multiplication and Division, Version 2.0",
          title_zh: "整数乘除法 `M` 扩展，版本 2.0",
        },
        "zh",
      ),
    ).toEqual({
      title: "整数乘除法 M 扩展",
      version: "2.0",
    });

    expect(
      formatTocChapterTitle(
        {
          title_en: '"Zicsr", Extension for Control and Status Register (CSR) Instructions, Version 2.0',
          title_zh: '用于指令取指的 "Zifencei" 扩展，版本 2.0',
        },
        "zh",
      ),
    ).toEqual({
      title: "用于指令取指的 “Zifencei” 扩展",
      version: "2.0",
    });
  });
});

describe("untranslated content progress and rendering", () => {
  it("counts untranslated translatable blocks separately in bundleProgress", () => {
    const chapter: ResolvedChapter = {
      struct_hash: "abc",
      pack_hash: "def",
      volume_id: "unpriv",
      chapter_id: "rv32i",
      sectname: "chapter",
      sectnum: "1",
      title_en: "RV32I",
      title_zh: "RV32I",
      sections: [
        {
          id: "rv32i",
          level: 1,
          sectnum: "1",
          title_en: "RV32I",
          title_zh: "RV32I",
          blocks: [
            "00000000000000000000000000000001",
            "00000000000000000000000000000002",
            "00000000000000000000000000000003",
            "00000000000000000000000000000004",
            "00000000000000000000000000000005",
          ],
        },
      ],
      units: {
        "00000000000000000000000000000001": {
          unit_id: "00000000000000000000000000000001",
          kind: "paragraph",
          translatable: true,
          status: "approved",
          en_html: "<p>One</p>",
          zh_html: "<p>一</p>",
        },
        "00000000000000000000000000000002": {
          unit_id: "00000000000000000000000000000002",
          kind: "paragraph",
          translatable: true,
          status: "machine",
          en_html: "<p>Two</p>",
          zh_html: "<p>二</p>",
        },
        "00000000000000000000000000000003": {
          unit_id: "00000000000000000000000000000003",
          kind: "paragraph",
          translatable: true,
          status: "machine",
          en_html: "<p>Three</p>",
          zh_html: "<p>三</p>",
        },
        "00000000000000000000000000000004": {
          unit_id: "00000000000000000000000000000004",
          kind: "paragraph",
          translatable: true,
          status: "untranslated",
          en_html: "<p>Four</p>",
        },
        "00000000000000000000000000000005": {
          unit_id: "00000000000000000000000000000005",
          kind: "code",
          translatable: false,
          en_html: "<pre>addi x1, x0, 1</pre>",
        },
      },
    };

    expect(bundleProgress(chapter)).toEqual({
      total: 4,
      approved: 1,
      machine: 2,
      untranslated: 1,
    });
  });

  it("falls back to English cleanly for untranslated headings and body blocks across reading modes", () => {
    const untranslatedBody: RenderedUnit = {
      unit_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      kind: "paragraph",
      translatable: true,
      status: "untranslated",
      en_html: "<p>Untranslated English body.</p>",
    };

    for (const lang of ["zh", "parallel", "interleave", "en"] as const) {
      const html = renderToStaticMarkup(
        React.createElement(DocBlock, {
          unitId: untranslatedBody.unit_id,
          block: untranslatedBody,
          lang,
          tapToReveal: true,
          showAnchors: false,
          permalink: "#/doc",
          onInspect: () => {},
          onCopyLink: () => {},
        }),
      );
      expect(html).toContain('data-untranslated="true"');
      expect(html).toContain("Untranslated English body.");
      expect(html).not.toContain("doc-parallel");
      expect(html).not.toContain("doc-interleave-sub");
      expect(html).not.toContain("显示英文原文");
    }

    const untranslatedHeading: RenderedUnit = {
      unit_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      kind: "heading",
      translatable: true,
      status: "untranslated",
      en_html: "<h2>English Heading</h2>",
    };

    const headingParallelHtml = renderToStaticMarkup(
      React.createElement(DocBlock, {
        unitId: untranslatedHeading.unit_id,
        block: untranslatedHeading,
        level: 2,
        lang: "parallel",
        sectnum: "2.1",
        tapToReveal: false,
        showAnchors: false,
        permalink: "#/doc#sec",
        onInspect: () => {},
        onCopyLink: () => {},
      }),
    );
    expect(headingParallelHtml).toContain('data-untranslated="true"');
    expect(headingParallelHtml).toContain("English Heading");
    expect(headingParallelHtml).not.toContain("doc-heading-sub");

    const emptyBlock: RenderedUnit = {
      unit_id: "cccccccccccccccccccccccccccccccc",
      kind: "paragraph",
      translatable: true,
      status: "untranslated",
      en_html: "",
    };
    const missingHtml = renderToStaticMarkup(
      React.createElement(DocBlock, {
        unitId: emptyBlock.unit_id,
        block: emptyBlock,
        lang: "zh",
        tapToReveal: false,
        showAnchors: false,
        permalink: "#/doc#missing",
        onInspect: () => {},
        onCopyLink: () => {},
      }),
    );
    expect(missingHtml).toContain("此段落尚未同步原文与译文");
  });
});
