import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeUnitId,
  expandRiscvMacrosForHtml,
  expandRiscvMacrosPlain,
  extractCodeSymbols,
  extractRiscvMacroTokens,
  htmlToPlainText,
  normalizeAdocBlock,
  parseRepositorySnapshot,
  parseVolumeEntry,
  renderAdocFragment,
  rewriteHtmlXrefs,
} from "../src/parser/index.ts";
import { formatBibEntry, parseBibtex } from "../src/parser/bibtex.ts";

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "riscv-parser-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("normalizeAdocBlock & computeUnitId", () => {
  it("strips leading [#id] and [[id]] anchors and preserves prose/math/xrefs", () => {
    const res1 = normalizeAdocBlock(
      "[#norm:add_ovf]\r\nArithmetic overflow is ignored; see <<sec:rv32i>>, `ADD`, and stem:[x + y].  \r\n\r\n",
    );
    expect(res1.anchorId).toBe("norm:add_ovf");
    expect(res1.normalized).toBe(
      "Arithmetic overflow is ignored; see <<sec:rv32i>>, `ADD`, and stem:[x + y].",
    );

    const res2 = normalizeAdocBlock(
      '[#norm:add_ovf,reftext="ADD overflow"]\nArithmetic overflow is ignored; see <<sec:rv32i>>, `ADD`, and stem:[x + y].',
    );
    expect(res2.anchorId).toBe("norm:add_ovf");
    expect(res2.normalized).toBe(res1.normalized);

    const res3 = normalizeAdocBlock(
      "[[norm_add_ovf]]\nArithmetic overflow is ignored; see <<sec:rv32i>>, `ADD`, and stem:[x + y].",
    );
    expect(res3.anchorId).toBe("norm_add_ovf");
    expect(res3.normalized).toBe(res1.normalized);

    expect(computeUnitId("paragraph", res1.normalized)).toBe(
      computeUnitId("paragraph", res3.normalized),
    );
  });

  it("keeps the exact same unit_id across anchor-only edits in parsed documents", () => {
    const repoA = makeTempRepo();
    fs.mkdirSync(path.join(repoA, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repoA, "src/riscv-unprivileged.adoc"),
      `= Unprivileged\n\n== Integer Base\n\n[#norm:add_ovf]\nThe ADD instruction performs addition modulo 2^XLEN.\n`,
    );

    const repoB = makeTempRepo();
    fs.mkdirSync(path.join(repoB, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repoB, "src/riscv-unprivileged.adoc"),
      `= Unprivileged\n\n== Integer Base\n\n[#norm:add_ovf_v2]\nThe ADD instruction performs addition modulo 2^XLEN.\n`,
    );

    const snapA = parseVolumeEntry(repoA, "unpriv", "src/riscv-unprivileged.adoc");
    const snapB = parseVolumeEntry(repoB, "unpriv", "src/riscv-unprivileged.adoc");

    const paraA = snapA.volume.chapters[0].sections[0].blocks[0];
    const paraB = snapB.volume.chapters[0].sections[0].blocks[0];
    expect(paraA.anchor_id).toBe("norm:add_ovf");
    expect(paraB.anchor_id).toBe("norm:add_ovf_v2");
    expect(paraA.unit_id).toBe(paraB.unit_id);
  });

  it("computes pure content-addressed 32-char lowercase hex SHA-256 IDs", () => {
    const id1 = computeUnitId("paragraph", "Hello RISC-V");
    const id2 = computeUnitId("paragraph", "Hello RISC-V");
    const idHeading = computeUnitId("heading", "Hello RISC-V");
    expect(id1).toMatch(/^[0-9a-f]{32}$/);
    expect(id1).toBe(id2);
    expect(id1).not.toBe(idHeading);
  });
});

describe("parseVolumeEntry & block atomicity", () => {
  it("keeps lists, tables, and [NOTE]/example/sidebar blocks whole without internal splitting", () => {
    const repo = makeTempRepo();
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "src/ch1.adoc"),
      `[#ch:rv32i]
== RV32I Base Integer Instruction Set
:chapter-status: Ratified

[#norm:rv32i_intro]
RV32I defines 40 instructions.

* Item one
** Nested item A
** Nested item B
* Item two
+
Continuation paragraph inside list.

.Instruction Formats
[cols="1,2"]
|===
| Format | Description
| R-type | Register-register
| I-type | Immediate
|===

[NOTE]
====
Note paragraph one.

Note paragraph two.
====

[example]
====
Example body line 1.

Example body line 2.
====

[source,asm]
----
add x1, x2, x3
----

[wavedrom, , svg]
....
{"reg": [{"bits": 7, "name": "opcode"}, {"bits": 5, "name": "rd"}]}
....

[bytefield]
----
(draw-box "opcode" {:span 7})
----

[stem]
++++
x = a + b
++++
`,
    );
    fs.writeFileSync(
      path.join(repo, "src/riscv-unprivileged.adoc"),
      `= Unprivileged ISA\n\ninclude::ch1.adoc[]\n`,
    );

    const { volume, units } = parseVolumeEntry(
      repo,
      "unpriv",
      "src/riscv-unprivileged.adoc",
    );

    expect(volume.chapters).toHaveLength(1);
    const ch = volume.chapters[0];
    expect(ch.id).toBe("ch:rv32i");
    expect(ch.source_path).toBe("src/ch1.adoc");
    expect(ch.sections).toHaveLength(1);

    const sec0 = ch.sections[0];
    expect(units.get(sec0.heading_unit_id!)?.kind).toBe("heading");
    expect(units.get(sec0.heading_unit_id!)?.en).toBe("RV32I Base Integer Instruction Set");

    const blocks = sec0.blocks;
    const kinds = blocks.map((b) => units.get(b.unit_id)?.kind);
    expect(kinds).toEqual([
      "paragraph",
      "list",
      "table",
      "block", // [NOTE]
      "block", // [example]
      "code", // [source,asm]
      "diagram", // [wavedrom]
      "diagram", // [bytefield]
      "math", // [stem]
    ]);

    const listUnit = units.get(blocks[1].unit_id)!;
    expect(listUnit.en).toContain("** Nested item A");
    expect(listUnit.en).toContain("Continuation paragraph inside list.");
    expect(listUnit.translatable).toBe(true);

    const tableUnit = units.get(blocks[2].unit_id)!;
    expect(tableUnit.en).toContain(".Instruction Formats");
    expect(tableUnit.en).toContain("| R-type | Register-register");

    const noteUnit = units.get(blocks[3].unit_id)!;
    expect(noteUnit.en).toContain("[NOTE]");
    expect(noteUnit.en).toContain("Note paragraph one.");
    expect(noteUnit.en).toContain("Note paragraph two.");

    expect(units.get(blocks[5].unit_id)!.translatable).toBe(false);
    expect(units.get(blocks[6].unit_id)!.translatable).toBe(false);
    expect(units.get(blocks[7].unit_id)!.translatable).toBe(false);
    expect(units.get(blocks[8].unit_id)!.translatable).toBe(false);
  });

  it("deduplicates identical headings and blocks cleanly by pure content-addressed unit_id", () => {
    const repo = makeTempRepo();
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "src/riscv-unprivileged.adoc"),
      `= Manual

[#sec:a]
== Overview

Reserved for future standard use.

[#sec:b]
== Overview

Reserved for future standard use.
`,
    );
    fs.writeFileSync(
      path.join(repo, "src/riscv-privileged.adoc"),
      `= Privileged Manual

[#sec:c]
== Overview

Reserved for future standard use.
`,
    );

    const snapshot = parseRepositorySnapshot(repo);
    expect(snapshot.volumes).toHaveLength(2);

    const headingIds = snapshot.volumes.flatMap((v) =>
      v.chapters.flatMap((c) => c.sections.map((s) => s.heading_unit_id!)),
    );
    const allBlockRefs = snapshot.volumes.flatMap((v) =>
      v.chapters.flatMap((c) => c.sections.flatMap((s) => s.blocks)),
    );
    expect(headingIds).toHaveLength(3);
    expect(allBlockRefs).toHaveLength(3);
    // Identical headings share 1 unit_id; identical paragraphs share 1 unit_id;
    // plus 2 distinct volume title headings = 4 unique units total.
    expect(new Set(headingIds).size).toBe(1);
    expect(new Set(allBlockRefs.map((b) => b.unit_id)).size).toBe(1);
    expect(snapshot.volumes.every((v) => Boolean(v.title_unit_id))).toBe(true);
    expect(snapshot.units.size).toBe(4);
  });

  it("auto-detects standard entries including profiles and falls back cleanly on minimal fixtures", () => {
    const stdRepo = makeTempRepo();
    fs.mkdirSync(path.join(stdRepo, "src/profiles"), { recursive: true });
    fs.writeFileSync(
      path.join(stdRepo, "src/riscv-unprivileged.adoc"),
      `= Unpriv\n\n== Ch U\n\nPara U.\n`,
    );
    fs.writeFileSync(
      path.join(stdRepo, "src/riscv-privileged.adoc"),
      `= Priv\n\n== Ch P\n\nPara P.\n`,
    );
    fs.writeFileSync(
      path.join(stdRepo, "src/profiles/rva23.adoc"),
      `= RVA23\n\n== RVA23 Profile\n:chapter-status: Frozen\n\nProfile details.\n`,
    );

    const stdSnap = parseRepositorySnapshot(stdRepo);
    expect(stdSnap.volumes.map((v) => v.id)).toEqual([
      "unpriv",
      "priv",
      "profiles",
    ]);

    const minRepo = makeTempRepo();
    fs.mkdirSync(path.join(minRepo, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(minRepo, "src/main.adoc"),
      `= Minimal\n\ninclude::sub.adoc[]\n`,
    );
    fs.writeFileSync(
      path.join(minRepo, "src/sub.adoc"),
      `== Sub Chapter\n\nDraft text.\n`,
    );

    const minSnap = parseRepositorySnapshot(minRepo);
    expect(minSnap.volumes).toHaveLength(1);
    expect(minSnap.volumes[0].chapters).toHaveLength(1);
    expect(minSnap.volumes[0].chapters[0].title_en).toBe("Sub Chapter");
  });

  it("handles missing docs-resources/global-config.adoc via fallback without bogus units or broken headers", () => {
    const repo = makeTempRepo();
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "src/riscv-unprivileged.adoc"),
      [
        "[[header]]",
        ":description: Unprivileged ISA",
        "include::../docs-resources/global-config.adoc[]",
        ":doctype: book",
        "",
        "= Volume I: Unprivileged",
        "",
        "== Chapter U",
        "",
        "Equation stem:[x + 1].",
        "",
        "[stem]",
        "++++",
        "y = mx + b",
        "++++",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(repo, "src/riscv-privileged.adoc"),
      [
        "[[header]]",
        ":description: Privileged ISA",
        "include::../docs-resources/global-config.adoc[]",
        ":doctype: book",
        "",
        "= Volume II: Privileged",
        "",
        "= Part I",
        "",
        "== Chapter P",
        "",
        "Privileged body.",
      ].join("\n"),
    );

    const snap = parseRepositorySnapshot(repo);
    expect(snap.volumes.map((v) => v.id)).toEqual(["unpriv", "priv"]);
    expect(snap.volumes[0].chapters.map((c) => c.title_en)).toEqual(["Chapter U"]);
    expect(snap.volumes[1].chapters.map((c) => c.title_en)).toEqual(["Chapter P"]);

    for (const unit of snap.units.values()) {
      expect(unit.en).not.toContain("Unresolved directive");
      expect("origin_hint" in unit).toBe(false);
    }

    const unprivVol = snap.volumes[0];
    const unprivUnits = [
      snap.units.get(unprivVol.title_unit_id!)!,
      snap.units.get(unprivVol.chapters[0].sections[0].heading_unit_id!)!,
      ...unprivVol.chapters[0].sections[0].blocks.map((b) => snap.units.get(b.unit_id)!),
    ];
    expect(unprivUnits.map((u) => u.kind)).toEqual(["heading", "heading", "paragraph", "math"]);
    expect(unprivUnits[0].en).toBe("Volume I: Unprivileged");
    expect(unprivUnits[1].en).toBe("Chapter U");
    expect(unprivUnits[2].en).toBe("Equation stem:[x + 1].");
    expect(unprivUnits[3].en).toBe("[stem]\n++++\ny = mx + b\n++++");
  });

  it("prefers real docs-resources/global-config.adoc on disk when present", () => {
    const repo = makeTempRepo();
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.mkdirSync(path.join(repo, "docs-resources"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "docs-resources/global-config.adoc"),
      ":stem: latexmath\n:from-real-global-config:\n",
    );
    fs.writeFileSync(
      path.join(repo, "src/riscv-unprivileged.adoc"),
      [
        "= Volume I",
        ":doctype: book",
        "include::../docs-resources/global-config.adoc[]",
        "",
        "== Chapter 1",
        "",
        "ifdef::from-real-global-config[]",
        "Loaded from real global-config.",
        "endif::[]",
      ].join("\n"),
    );

    const snap = parseRepositorySnapshot(repo);
    const texts = [...snap.units.values()].map((u) => u.en);
    expect(texts).toContain("Loaded from real global-config.");
  });

  it("drops genuinely broken include directives and empty implicit chapters", () => {
    const repo = makeTempRepo();
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "src/riscv-unprivileged.adoc"),
      [
        "= Volume I",
        ":doctype: book",
        ":toc:",
        "",
        "toc::[]",
        "",
        "include::missing-chapter.adoc[]",
        "",
        "== Valid Chapter",
        "",
        "Valid paragraph.",
      ].join("\n"),
    );

    const snap = parseRepositorySnapshot(repo);
    expect(snap.volumes[0].chapters).toHaveLength(1);
    expect(snap.volumes[0].chapters[0].title_en).toBe("Valid Chapter");
    for (const unit of snap.units.values()) {
      expect(unit.en).not.toContain("Unresolved directive");
    }
  });

  it("omits book colophon preambles, empty [index], unexpanded [bibliography], and deduplicates profiles umbrella includes", () => {
    const repo = makeTempRepo();
    fs.mkdirSync(path.join(repo, "src/profiles"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "src/riscv-unprivileged.adoc"),
      [
        "= The RISC-V Instruction Set Manual, Volume I: Unprivileged Architecture",
        ":doctype: book",
        "",
        "_This document is released under CC-BY 4.0._",
        "",
        "[preface]",
        "== Preface",
        "",
        "Preface text.",
        "",
        "[#mstandard]",
        "== `M` Extension for Integer Multiplication, Version 2.0",
        "",
        "Multiply instructions.",
        "",
        "[index]",
        "== Index",
        "",
        "[bibliography]",
        "== Bibliography",
        "",
        "bibliography::[]",
      ].join("\n"),
    );

    // Partial files alphabetically precede the umbrella file (`intro.adoc`, `preface.adoc` < `riscv-profiles.adoc`)
    fs.writeFileSync(
      path.join(repo, "src/profiles/intro.adoc"),
      "== Introduction\n\nProfiles overview.\n",
    );
    fs.writeFileSync(
      path.join(repo, "src/profiles/preface.adoc"),
      "== Preface\n\nProfiles preface.\n",
    );
    fs.writeFileSync(
      path.join(repo, "src/profiles/rva23.adoc"),
      "= RISC-V Profiles\n:doctype: book\n\ninclude::preface.adoc[]\n\ninclude::intro.adoc[]\n\n== RVA23 Profiles\n\nRVA23 details.\n",
    );

    const snap = parseRepositorySnapshot(repo);
    const unpriv = snap.volumes.find((v) => v.id === "unpriv")!;
    expect(unpriv.title_en).toBe(
      "The RISC-V Instruction Set Manual, Volume I: Unprivileged Architecture",
    );
    expect("title_zh" in unpriv).toBe(false);
    expect(unpriv.title_unit_id).toBeDefined();
    expect(unpriv.chapters.map((c) => c.id)).toEqual(["_preface", "mstandard"]);
    expect(unpriv.chapters[0].sectname).toBe("preface");
    expect(unpriv.chapters[0].sectnum).toBeNull();
    expect(unpriv.chapters[1].sectname).toBe("chapter");
    expect(unpriv.chapters[1].sectnum).toBeNull(); // no :sectnums: in this fixture
    expect(unpriv.chapters[1].title_en).toBe(
      "M Extension for Integer Multiplication, Version 2.0",
    );

    const profiles = snap.volumes.find((v) => v.id === "profiles")!;
    expect(profiles.title_en).toBe("RISC-V Profiles");
    expect(profiles.title_unit_id).toBeDefined();
    expect(profiles.chapters.map((c) => c.id)).toEqual([
      "_preface",
      "_introduction",
      "_rva23_profiles",
    ]);
  });

  it("extracts exact AsciiDoc sectname & sectnum across preface, :!sectnums:, chapters, subsections, sectnumlevels, appendices, and unified multi-part riscv-spec.adoc", () => {
    const repo = makeTempRepo();
    fs.mkdirSync(path.join(repo, "src/profiles"), { recursive: true });

    fs.writeFileSync(
      path.join(repo, "src/riscv-spec.adoc"),
      [
        "= The RISC-V Instruction Set Manual",
        ":doctype: book",
        ":sectnums:",
        ":sectnumlevels: 3",
        "",
        "include::unpriv.adoc[]",
        "",
        "include::priv.adoc[]",
        "",
        "include::profiles/profiles.adoc[]",
      ].join("\n"),
    );

    fs.writeFileSync(
      path.join(repo, "src/unpriv.adoc"),
      [
        "= Volume I: Unprivileged Architecture",
        "",
        "Colophon paragraph inside part preamble that precedes Preface.",
        "",
        "[preface]",
        "== Preface",
        "",
        "Preface body.",
        "",
        "=== Preface Subsection",
        "",
        "Preface subsection body.",
        "",
        ":!sectnums:",
        "== Terms and Definitions",
        "",
        "Unnumbered chapter body.",
        "",
        "=== Terminology Detail",
        "",
        "Unnumbered child section body.",
        "",
        ":sectnums:",
        "== Introduction",
        "",
        "Chapter 1 intro.",
        "",
        "=== RISC-V ISA Overview",
        "",
        "Section 1.1 body.",
        "",
        "==== Modular ISA",
        "",
        "Section 1.1.1 body.",
        "",
        "===== Deep Heading Beyond sectnumlevels",
        "",
        "Level 4 (> sectnumlevels=3) must have sectnum: null.",
        "",
        "[appendix]",
        "== RVWMO Explanatory Material",
        "",
        "Appendix A intro.",
        "",
        "=== Why RVWMO?",
        "",
        "Appendix A.1 body.",
      ].join("\n"),
    );

    fs.writeFileSync(
      path.join(repo, "src/priv.adoc"),
      [
        "= Volume II: Privileged Architecture",
        "",
        "== Machine-Level ISA",
        "",
        "Machine chapter body.",
      ].join("\n"),
    );

    fs.writeFileSync(
      path.join(repo, "src/profiles/profiles.adoc"),
      [
        "= Volume III: Profiles",
        "",
        "== RVA23 Profiles",
        "",
        "RVA23 body.",
      ].join("\n"),
    );

    const snap = parseRepositorySnapshot(repo);
    expect(snap.volumes.map((v) => v.id)).toEqual(["unpriv", "priv", "profiles"]);
    expect(snap.volumes.map((v) => v.title_en)).toEqual([
      "Volume I: Unprivileged Architecture",
      "Volume II: Privileged Architecture",
      "Volume III: Profiles",
    ]);
    expect(new Set(snap.volumes.map((v) => v.title_unit_id)).size).toBe(3);

    const unpriv = snap.volumes[0];
    expect(
      unpriv.chapters.map((c) => ({
        title: c.title_en,
        sectname: c.sectname,
        sectnum: c.sectnum,
      })),
    ).toEqual([
      { title: "Preface", sectname: "preface", sectnum: null },
      { title: "Terms and Definitions", sectname: "chapter", sectnum: null },
      { title: "Introduction", sectname: "chapter", sectnum: "1" },
      { title: "RVWMO Explanatory Material", sectname: "appendix", sectnum: "A" },
    ]);

    // Preface subsection is also unnumbered
    expect(unpriv.chapters[0].sections.map((s) => [s.title, s.sectnum])).toEqual([
      ["Preface", null],
      ["Preface Subsection", null],
    ]);

    // :!sectnums: chapter and its child subsection are unnumbered
    expect(unpriv.chapters[1].sections.map((s) => [s.title, s.sectnum])).toEqual([
      ["Terms and Definitions", null],
      ["Terminology Detail", null],
    ]);

    // Chapter 1 sections honor sectnumlevels=3 (level 4 gets null)
    expect(unpriv.chapters[2].sections.map((s) => [s.title, s.level, s.sectnum])).toEqual([
      ["Introduction", 1, "1"],
      ["RISC-V ISA Overview", 2, "1.1"],
      ["Modular ISA", 3, "1.1.1"],
      ["Deep Heading Beyond sectnumlevels", 4, null],
    ]);

    // Appendix A and A.1
    expect(unpriv.chapters[3].sections.map((s) => [s.title, s.sectnum])).toEqual([
      ["RVWMO Explanatory Material", "A"],
      ["Why RVWMO?", "A.1"],
    ]);
  });
});

describe("renderAdocFragment", () => {
  it("renders paragraphs with KaTeX math, tables, headings, and admonitions", () => {
    const mathPara = renderAdocFragment(
      "Value stem:[x^2 + y^2] and latexmath:[a < b].",
      "paragraph",
    );
    expect(mathPara).toContain('class="katex"');
    expect(mathPara).not.toContain("<html");

    const blockMath = renderAdocFragment("[stem]\n++++\nE = mc^2\n++++", "math");
    expect(blockMath).toContain('class="katex-display"');

    const tableHtml = renderAdocFragment(
      "|===\n| Col1 | Col2\n| A | B\n|===",
      "table",
    );
    expect(tableHtml).toContain("<table");
    expect(tableHtml).toContain("Col1");

    const noteHtml = renderAdocFragment(
      "[NOTE]\n====\nWatch out.\n====",
      "block",
    );
    expect(noteHtml).toContain("admonitionblock");
    expect(noteHtml).toContain("Watch out.");

    const headingHtml = renderAdocFragment("== Integer Base", "heading");
    expect(headingHtml).toContain("<h2");
    expect(headingHtml).toContain("Integer Base");
    expect(headingHtml).not.toContain("sectionbody");

    const markerlessHeadingHtml = renderAdocFragment("Integer Base", "heading");
    expect(markerlessHeadingHtml).toContain("<h2");
    expect(markerlessHeadingHtml).toContain("Integer Base");

    const macroHtml = renderAdocFragment(
      "Use insn:addi[rd, rs1, imm], insnlink:jal[], csr:mstatus[MIE], ext:Zicond[], extlink:M[], and qty:32[bits].",
      "paragraph",
    );
    expect(macroHtml).toContain("<code>ADDI rd, rs1, imm</code>");
    expect(macroHtml).toContain('href="#insns-jal"');
    expect(macroHtml).toContain("<code>mstatus.MIE</code>");
    expect(macroHtml).toContain('<span class="rv-ext">Zicond</span>');
    expect(macroHtml).toContain('data-rv-extlink="M"');
    expect(macroHtml).toContain('class="rv-qty"');
    expect(macroHtml).not.toContain("insnlink:");

    const rewritten = rewriteHtmlXrefs(
      `${macroHtml}<p>See <a href="#_overview">[_overview]</a> and <a href="#ref1">[ref1]</a>.</p>`,
      "zh",
      new Map([
        [
          "_overview",
          {
            anchor_id: "_overview",
            volume_id: "unpriv",
            chapter_id: "intro",
            sectnum: "1",
            kind: "section",
            title_en: "Overview",
            title_zh: "概述",
          },
        ],
        [
          "m-ext",
          {
            anchor_id: "m-ext",
            volume_id: "unpriv",
            chapter_id: "m",
            sectnum: "12",
            kind: "section",
            title_en: "M Extension",
            title_zh: "M 扩展",
          },
        ],
        [
          "insns-jal",
          {
            anchor_id: "insns-jal",
            volume_id: "unpriv",
            chapter_id: "rv32i",
            sectnum: "2.5",
            kind: "section",
            title_en: "JAL",
            title_zh: "JAL",
          },
        ],
        [
          "ref1",
          {
            anchor_id: "ref1",
            volume_id: "unpriv",
            chapter_id: "bib",
            sectnum: null,
            kind: "list",
            is_bibliography: true,
          },
        ],
      ]),
    );
    expect(rewritten).toContain('class="rv-extlink xref-resolved"');
    expect(rewritten).toContain('href="#m-ext"');
    expect(rewritten).toContain('class="rv-insnlink xref-resolved"');
    expect(rewritten).toContain('href="#insns-jal"');
    expect(rewritten).toContain('class="xref-resolved"');
    expect(rewritten).toContain("第 1 章“概述”");
    expect(rewritten).toContain('class="cite-ref"');
  });

  it("renders WaveDrom and Bytefield SVGs and falls back safely on malformed diagrams", () => {
    const wdValid = renderAdocFragment(
      '[wavedrom, , svg]\n....\n{"signal": [{"name": "clk", "wave": "p...."}]}\n....',
      "diagram",
    );
    expect(wdValid).toContain('class="diagram-svg"');
    expect(wdValid).toContain("<svg");

    const wdJson5Reg = renderAdocFragment(
      `[wavedrom, , svg]
....
{reg: [
  {bits: 7,  name: 'opcode',   attr: ['7', 'STORE']},
  {bits: 5,  name: 'imm[4:0]', attr: ['5', 'offset[4:0]']},
  {bits: 3,  name: 'funct3', attr: ['3', 'width']},
  {bits: 5,  name: 'rs1', attr: ['5', 'base']},
  {bits: 5,  name: 'rs2', attr: ['5', 'src']},
  {bits: 7, name: 'imm[11:5]', attr: ['7', 'offset[11:5]']},
]}
....`,
      "diagram",
    );
    expect(wdJson5Reg).toContain('class="diagram-svg"');
    expect(wdJson5Reg).toContain("<svg");
    expect(wdJson5Reg).toContain("STORE");

    const wdMalformed = renderAdocFragment(
      "[wavedrom, , svg]\n....\n{not valid json\n....",
      "diagram",
    );
    expect(wdMalformed).toContain("<pre");
    expect(wdMalformed).toContain("<code>");

    const wdEmptyObj = renderAdocFragment(
      '[wavedrom, , svg]\n....\n{"foo": "bar"}\n....',
      "diagram",
    );
    expect(wdEmptyObj).toContain("<pre");

    const bfValid = renderAdocFragment(
      '[bytefield]\n----\n(draw-box "opcode" {:span 7})\n----',
      "diagram",
    );
    expect(bfValid).toContain('class="diagram-svg"');
    expect(bfValid).toContain("<svg");
    expect(bfValid).not.toContain("<?xml");

    const bfMalformed = renderAdocFragment(
      "[bytefield]\n----\n(unclosed-paren\n----",
      "diagram",
    );
    expect(bfMalformed).toContain("<pre");
    expect(bfMalformed).toContain("<code>");
  });

  it("highlights code blocks with Shiki while preserving callouts, and renders nested diagrams", () => {
    const codeHtml = renderAdocFragment(
      '[source,c]\n----\n// comment\nuint32_t x = 0x10; // <1>\nreturn x;\n----\n<1> hex value',
      "code",
    );
    expect(codeHtml).toContain("--shiki-light:");
    expect(codeHtml).toContain("--shiki-dark:");
    expect(codeHtml).toContain(">// comment</span>");
    expect(codeHtml).toContain(">uint32_t</span>");
    expect(codeHtml).toContain(">return</span>");
    expect(codeHtml).toContain('class="conum"');
    expect(codeHtml).toContain('class="colist arabic"');

    const asmHtml = renderAdocFragment(
      "[source,riscv]\n----\nloop:\n  addi a0, a1, 4 # bump pointer\n  ret\n----",
      "code",
    );
    expect(asmHtml).toContain("--shiki-light:");
    expect(asmHtml).toContain(">addi</span>");
    expect(asmHtml).toContain("># bump pointer</span>");

    const unknownLangHtml = renderAdocFragment(
      "[source,sail]\n----\nval execute : instruction -> Retired\n----",
      "code",
    );
    expect(unknownLangHtml).toContain("<pre");
    expect(unknownLangHtml).not.toContain("--shiki-light:");

    const nestedDiagram = renderAdocFragment(
      '[example]\n====\n[bytefield]\n----\n(draw-box "op" {:span 7})\n----\n====',
      "block",
    );
    expect(nestedDiagram).toContain('class="diagram-svg"');
    expect(nestedDiagram).toContain("<svg");
  });
});

describe("htmlToPlainText and extractCodeSymbols", () => {
  it("extracts clean plain text from headings, math, footnotes, and xrefs without KaTeX duplication", () => {
    const headingHtml = renderAdocFragment("=== Integer `ADDI` Instruction", "heading");
    expect(htmlToPlainText(headingHtml, "heading")).toBe("Integer ADDI Instruction");

    const paraHtml = renderAdocFragment(
      "Value stem:[2^{XLEN}] and stem:[0 \\le i < \\text{XLEN}] with `x0`–`x31` see <<sec:rv32i>> and <<insns-add>>footnote:[Overflow is ignored.].",
      "paragraph",
    );
    const plain = htmlToPlainText(paraHtml, "paragraph", {
      xrefTitles: new Map([["sec:rv32i", "RV32I Base Integer Instruction Set"]]),
    });
    expect(plain).toContain("2^XLEN");
    expect(plain).toContain("0 ≤ i < XLEN");
    expect(plain).toContain("x0–x31");
    expect(plain).toContain("RV32I Base Integer Instruction Set");
    expect(plain).toContain("Overflow is ignored.");
    expect(plain).not.toContain("<<");
    expect(plain).not.toContain("[1]");
    expect(plain).not.toContain("[sec:rv32i]");
    expect(plain).toContain("insns-add".replace(/^insns-/, ""));

    const blockMathHtml = renderAdocFragment("[stem]\n++++\nE = mc^2\n++++", "math");
    expect(htmlToPlainText(blockMathHtml, "math")).toBe("E = mc^2");
  });

  it("extracts tables, definition lists, admonitions, and code callouts without AsciiDoc delimiters", () => {
    const tableHtml = renderAdocFragment(
      ".CSR Table\n|===\n| CSR | Addr\n| `mstatus` | `0x300`\n|===",
      "table",
    );
    const tablePlain = htmlToPlainText(tableHtml, "table");
    expect(tablePlain).toBe("CSR Table — CSR · Addr — mstatus · 0x300");
    expect(tablePlain).not.toContain("Table 1.");
    expect(tablePlain).not.toContain("|===");

    const dlistHtml = renderAdocFragment(
      "Synopsis::\n`addi rd, rs1, imm`\nMnemonic::\n`addi`",
      "list",
    );
    expect(htmlToPlainText(dlistHtml, "list")).toBe(
      "Synopsis: addi rd, rs1, imm Mnemonic: addi",
    );

    const noteHtml = renderAdocFragment(
      "[NOTE]\n====\n`ADDI rd, rs1, 0` 用于实现伪指令 `MV rd, rs1`。\n====",
      "block",
    );
    const notePlain = htmlToPlainText(noteHtml, "block");
    expect(notePlain).toBe("ADDI rd, rs1, 0 用于实现伪指令 MV rd, rs1。");
    expect(notePlain).not.toContain("Note");
    expect(notePlain).not.toContain("====");

    const codeHtml = renderAdocFragment(
      "[source,riscv]\n----\naddi a0, a1, 4 # <1>\nret\n----\n<1> bump pointer",
      "code",
    );
    const codePlain = htmlToPlainText(codeHtml, "code");
    expect(codePlain).toContain("addi a0, a1, 4");
    expect(codePlain).toContain("bump pointer");
    expect(codePlain).not.toContain("(1)");
  });

  it("omits raw WaveDrom/Bytefield/image fallbacks while keeping cleaned diagram captions", () => {
    const wdUntitled = renderAdocFragment(
      '[wavedrom, , svg]\n....\n{"signal": [{"name": "clk", "wave": "p...."}]}\n....',
      "diagram",
    );
    expect(htmlToPlainText(wdUntitled, "diagram")).toBe("");

    const bfTitled = renderAdocFragment(
      '[bytefield]\n.Instruction Format\n----\n(draw-box "opcode" {:span 7})\n----',
      "diagram",
    );
    expect(htmlToPlainText(bfTitled, "diagram")).toBe("Instruction Format");

    const imgUntitled = renderAdocFragment("image::u-imm.png[]", "diagram");
    expect(htmlToPlainText(imgUntitled, "diagram")).toBe("");

    const imgTitled = renderAdocFragment(".U-type Immediate\nimage::u-imm.png[]", "diagram");
    expect(htmlToPlainText(imgTitled, "diagram")).toBe("U-type Immediate");

    const malformed = renderAdocFragment(
      "[bytefield]\n----\n(unclosed-paren\n----",
      "diagram",
    );
    expect(htmlToPlainText(malformed, "diagram")).toBe("");
  });

  it("cleans unexpanded RISC-V macros and extracts inline code symbols excluding pre code blocks", () => {
    const macroHtml = renderAdocFragment(
      "Execute insn:czero.eqz[rd, rs1, rs2] and check csr:mstatus[].\nindexterm:[mstatus]",
      "paragraph",
    );
    expect(htmlToPlainText(macroHtml, "paragraph")).toBe(
      "Execute CZERO.EQZ rd, rs1, rs2 and check mstatus.",
    );
    expect(
      htmlToPlainText("<p>Also indexterm2:[trap] keeps text clean.</p>", "paragraph"),
    ).toBe("Also keeps text clean.");

    const mixedHtml = renderAdocFragment(
      "The `ADDI` instruction adds `rs1` and implements `MV rd, rs1`, using `czero.eqz`.\n\n",
      "paragraph",
    );
    expect(extractCodeSymbols(mixedHtml)).toEqual(["ADDI", "rs1", "MV", "czero.eqz"]);

    const blockCodeHtml = renderAdocFragment(
      "[source,c]\n----\nuint32_t ignored_var = 0;\n----",
      "code",
    );
    expect(extractCodeSymbols(blockCodeHtml)).toEqual([]);
  });

  it("renders cite:[...] inline macros and parses BibTeX entries", () => {
    const html = renderAdocFragment(
      "See cite:[waterman2014, asanovic2014] and cite:t[patterson2017].",
      "paragraph",
    );
    expect(html).toContain('class="cite-ref"');
    expect(html).toContain('href="#bib-waterman2014"');
    expect(html).toContain('data-cite-key="asanovic2014"');
    expect(html).toContain('data-cite-mode="t"');

    const bib = parseBibtex(`
@techreport{waterman2014,
  author = {Andrew Waterman and Yunsup Lee},
  title = {{The RISC-V Instruction Set Manual}},
  institution = {UC Berkeley},
  year = {2014}
}
`);
    const entry = bib.get("waterman2014");
    expect(entry).toBeDefined();
    expect(formatBibEntry(entry!)).toContain("Andrew Waterman and Yunsup Lee");
    expect(formatBibEntry(entry!)).toContain("The RISC-V Instruction Set Manual");
    expect(formatBibEntry(entry!)).toContain("2014");
  });

  it("splits Volume IV: Debug and Trace into the debug volume", () => {
    const repo = makeTempRepo();
    fs.mkdirSync(path.join(repo, "src/debug"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "src/riscv-spec.adoc"),
      [
        "= The RISC-V Instruction Set Manual",
        ":doctype: book",
        "",
        "include::unpriv.adoc[]",
        "",
        "include::debug/debug.adoc[]",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(repo, "src/unpriv.adoc"),
      ["= Volume I: Unprivileged Architecture", "", "== Introduction", "", "Intro body."].join("\n"),
    );
    fs.writeFileSync(
      path.join(repo, "src/debug/debug.adoc"),
      ["= Volume IV: Debug and Trace", "", "== Debug Spec", "", "Debug body."].join("\n"),
    );

    const snap = parseRepositorySnapshot(repo);
    expect(snap.volumes.map((v) => v.id)).toEqual(["unpriv", "debug"]);
    expect(snap.volumes[1].title_en).toBe("Volume IV: Debug and Trace");
    expect(snap.volumes[1].chapters.map((c) => c.title_en)).toEqual(["Debug Spec"]);
  });

  it("preserves hyphen prefixes, canonicalizes inst: aliases, and protects multi-line curved quotes during macro expansion", () => {
    const extPrefixSrc = "Software for non-ext:ziccid[] machines and pre-ext:ziccid[] semantics.";
    expect(expandRiscvMacrosForHtml(extPrefixSrc)).toContain(
      'for non-+++<span class="rv-ext">Ziccid</span>+++ machines and pre-+++<span class="rv-ext">Ziccid</span>+++ semantics.',
    );
    expect(expandRiscvMacrosPlain(extPrefixSrc)).toBe(
      "Software for non-Ziccid machines and pre-Ziccid semantics.",
    );
    expect(extractRiscvMacroTokens(extPrefixSrc)).toEqual(["ext:ziccid[]", "ext:ziccid[]"]);

    const rangeSrc = "Counters csr:hpmcounter3[]-csr:hpmcounter31[]";
    expect(expandRiscvMacrosForHtml(rangeSrc)).toBe(
      "Counters +++<code>hpmcounter3</code>+++-+++<code>hpmcounter31</code>+++",
    );
    expect(expandRiscvMacrosPlain(rangeSrc)).toBe("Counters hpmcounter3-hpmcounter31");
    expect(extractRiscvMacroTokens(rangeSrc)).toEqual([
      "csr:hpmcounter3[]",
      "csr:hpmcounter31[]",
    ]);

    expect(extractRiscvMacroTokens("Without executing inst:fence.i[].")).toEqual([
      "insn:fence.i[]",
    ]);

    const multiLineCurved =
      'After "`Arbitrary unrelated\nload`", run insn:fence.i[] with `x0`.';
    expect(expandRiscvMacrosForHtml(multiLineCurved)).toBe(
      'After "`Arbitrary unrelated\nload`", run +++<code>FENCE.I</code>+++ with `x0`.',
    );
    expect(extractRiscvMacroTokens(multiLineCurved)).toEqual(["insn:fence.i[]"]);
  });
});
