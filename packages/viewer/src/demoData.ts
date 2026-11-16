import type {
  AnchorIndex,
  ChapterStructure,
  ChapterUnitPack,
  SearchEntry,
  SiteIndex,
  SiteTree,
  SiteVolume,
  UnitMeta,
  UnitMetaShard,
} from "./types";

const SHA_V1 = "9f12c0a8b41e7d3055c12a8e4b0033d1f0987abc";
const SHA_V2 = "3c7b4e11d8a9205f7123456789abcdef01234567";

const TREE_V1_HASH = "10000000000000000000000000000001";
const TREE_V2_HASH = "20000000000000000000000000000002";

const STRUCT_RV32I_V1 = "aa000000000000000000000000000001";
const PACK_RV32I_V1 = "bb000000000000000000000000000001";
const STRUCT_RV32I_V2 = "aa000000000000000000000000000002";
const PACK_RV32I_V2 = "bb000000000000000000000000000002";

const STRUCT_PRIV_V1 = "cc000000000000000000000000000001";
const PACK_PRIV_V1 = "dd000000000000000000000000000001";
const STRUCT_PRIV_V2 = "cc000000000000000000000000000002";
const PACK_PRIV_V2 = "dd000000000000000000000000000002";

const UID_RV32I_TITLE = "11000000000000000000000000000001";
const UID_SEC_INTRO_H = "12000000000000000000000000000002";
const UID_INTRO_P1 = "13000000000000000000000000000003";
const UID_INTRO_NOTE = "14000000000000000000000000000004";
const UID_SEC_ARITH_H = "15000000000000000000000000000005";
const UID_ADDI_P1_V1 = "16000000000000000000000000000006";
const UID_ADDI_P1_V2 = "17000000000000000000000000000007";
const UID_MV_PSEUDO = "18000000000000000000000000000008";
const UID_LEGACY_NOTE = "19000000000000000000000000000009";
const UID_FENCE_TSO = "1a00000000000000000000000000000a";
const UID_ZICOND_NEW = "1b00000000000000000000000000000b";

const UID_PRIV_TITLE = "21000000000000000000000000000001";
const UID_SEC_MSTATUS_H = "22000000000000000000000000000002";
const UID_MSTATUS_P1_V1 = "23000000000000000000000000000003";
const UID_MSTATUS_P1_V2 = "24000000000000000000000000000004";
const UID_MSTATUS_CODE = "25000000000000000000000000000005";

const VOLUMES_V1: SiteVolume[] = [
  {
    id: "unpriv",
    title_en: "The RISC-V Instruction Set Manual, Volume I: Unprivileged Architecture",
    title_zh: "RISC-V 指令集手册 第一卷：非特权级架构",
    chapters: [
      {
        id: "rv32i",
        sectname: "chapter",
        sectnum: "2",
        title_en: "RV32I Base Integer Instruction Set, Version 2.1",
        title_zh: "RV32I 基础整数指令集，版本 2.1",
        struct_hash: STRUCT_RV32I_V1,
        pack_hash: PACK_RV32I_V1,
      },
    ],
  },
  {
    id: "priv",
    title_en: "The RISC-V Instruction Set Manual, Volume II: Privileged Architecture",
    title_zh: "RISC-V 指令集手册 第二卷：特权级架构",
    chapters: [
      {
        id: "machine",
        sectname: "chapter",
        sectnum: "3",
        title_en: "Machine-Level ISA, Version 1.13",
        title_zh: "机器级指令集架构，版本 1.13",
        struct_hash: STRUCT_PRIV_V1,
        pack_hash: PACK_PRIV_V1,
      },
    ],
  },
];

const VOLUMES_V2: SiteVolume[] = [
  {
    id: "unpriv",
    title_en: "The RISC-V Instruction Set Manual, Volume I: Unprivileged Architecture",
    title_zh: "RISC-V 指令集手册 第一卷：非特权级架构",
    chapters: [
      {
        id: "rv32i",
        sectname: "chapter",
        sectnum: "2",
        title_en: "RV32I Base Integer Instruction Set, Version 2.1",
        title_zh: "RV32I 基础整数指令集，版本 2.1",
        struct_hash: STRUCT_RV32I_V2,
        pack_hash: PACK_RV32I_V2,
        changed_blocks: 4,
      },
    ],
  },
  {
    id: "priv",
    title_en: "The RISC-V Instruction Set Manual, Volume II: Privileged Architecture",
    title_zh: "RISC-V 指令集手册 第二卷：特权级架构",
    chapters: [
      {
        id: "machine",
        sectname: "chapter",
        sectnum: "3",
        title_en: "Machine-Level ISA, Version 1.13",
        title_zh: "机器级指令集架构，版本 1.13",
        struct_hash: STRUCT_PRIV_V2,
        pack_hash: PACK_PRIV_V2,
        changed_blocks: 1,
      },
    ],
  },
];

export const DEMO_TREES: Record<string, SiteTree> = {
  [TREE_V1_HASH]: {
    tree_hash: TREE_V1_HASH,
    volumes: VOLUMES_V1,
  },
  [TREE_V2_HASH]: {
    tree_hash: TREE_V2_HASH,
    volumes: VOLUMES_V2,
  },
};

export const DEMO_SITE_INDEX: SiteIndex = {
  generated_at: "2026-02-01T15:00:00Z",
  data_repo_url: "https://github.com/riscv-cn/riscv-isa-manual-zh",
  upstream_repo_url: "https://github.com/riscv/riscv-isa-manual",
  glossary_markdown:
    "- HART: 硬件线程\n- CSR: 控制与状态寄存器\n- XLEN: 整数寄存器位宽\n- ratified: 已批准冻结",
  default_sha: SHA_V2,
  default_tree_hash: TREE_V2_HASH,
  default_volumes: VOLUMES_V2,
  snapshots: [
    {
      sha: SHA_V1,
      parent_sha: null,
      is_baseline: true,
      date: "2026-01-12T08:00:00Z",
      title: "docs: ratify Unprivileged Spec 20250112 baseline",
      ratified_tag: "20250112",
      draft_tags: [],
      diff: { added: 0, modified: 0, deleted: 0, moved: 0, touched_chapters: [] },
      approval_ratio: 0.78,
      tree_hash: TREE_V1_HASH,
    },
    {
      sha: SHA_V2,
      parent_sha: SHA_V1,
      is_baseline: false,
      date: "2026-02-01T14:30:00Z",
      title: "RV32I & Priv: clarify ADDI overflow wording, move FENCE.TSO, update mstatus.MPRV",
      ratified_tag: null,
      draft_tags: ["draft-20260201"],
      diff: {
        added: 1,
        modified: 2,
        deleted: 1,
        moved: 1,
        touched_chapters: ["unpriv/rv32i", "priv/machine"],
      },
      approval_ratio: 0.7,
      tree_hash: TREE_V2_HASH,
    },
  ],
};

export const DEMO_STRUCTURES: Record<string, ChapterStructure> = {
  [STRUCT_RV32I_V1]: {
    struct_hash: STRUCT_RV32I_V1,
    volume_id: "unpriv",
    chapter_id: "rv32i",
    sectname: "chapter",
    sectnum: "2",
    title_en: "RV32I Base Integer Instruction Set, Version 2.1",
    title_zh: "RV32I 基础整数指令集，版本 2.1",
    title_unit_id: UID_RV32I_TITLE,
    sections: [
      {
        id: "sec-intro",
        level: 2,
        sectnum: "2.1",
        title_en: "Programmers' Model for Base Integer ISA",
        title_zh: "基础整数指令集的程序员模型",
        heading_unit_id: UID_SEC_INTRO_H,
        heading_anchor_id: "sec-intro",
        blocks: [
          { unit_id: UID_INTRO_P1, anchor_id: "xlen-32" },
          UID_INTRO_NOTE,
          { unit_id: UID_FENCE_TSO, anchor_id: "fence-tso" },
        ],
      },
      {
        id: "sec-arith",
        level: 2,
        sectnum: "2.2",
        title_en: "Integer Register-Immediate Instructions",
        title_zh: "整数寄存器-立即数指令",
        heading_unit_id: UID_SEC_ARITH_H,
        heading_anchor_id: "insns-addi",
        heading_extra_anchors: ["norm:addi_op"],
        blocks: [
          UID_ADDI_P1_V1,
          UID_MV_PSEUDO,
          UID_LEGACY_NOTE,
        ],
      },
    ],
  },
  [STRUCT_RV32I_V2]: {
    struct_hash: STRUCT_RV32I_V2,
    volume_id: "unpriv",
    chapter_id: "rv32i",
    sectname: "chapter",
    sectnum: "2",
    title_en: "RV32I Base Integer Instruction Set, Version 2.1",
    title_zh: "RV32I 基础整数指令集，版本 2.1",
    title_unit_id: UID_RV32I_TITLE,
    sections: [
      {
        id: "sec-intro",
        level: 2,
        sectnum: "2.1",
        title_en: "Programmers' Model for Base Integer ISA",
        title_zh: "基础整数指令集的程序员模型",
        heading_unit_id: UID_SEC_INTRO_H,
        heading_anchor_id: "sec-intro",
        blocks: [
          { unit_id: UID_INTRO_P1, anchor_id: "xlen-32" },
          UID_INTRO_NOTE,
        ],
      },
      {
        id: "sec-arith",
        level: 2,
        sectnum: "2.2",
        title_en: "Integer Register-Immediate Instructions",
        title_zh: "整数寄存器-立即数指令",
        heading_unit_id: UID_SEC_ARITH_H,
        heading_anchor_id: "insns-addi",
        heading_extra_anchors: ["norm:addi_op"],
        blocks: [
          UID_ADDI_P1_V2,
          UID_MV_PSEUDO,
          { unit_id: UID_FENCE_TSO, anchor_id: "fence-tso" },
          UID_ZICOND_NEW,
        ],
      },
    ],
  },
  [STRUCT_PRIV_V1]: {
    struct_hash: STRUCT_PRIV_V1,
    volume_id: "priv",
    chapter_id: "machine",
    sectname: "chapter",
    sectnum: "3",
    title_en: "Machine-Level ISA, Version 1.13",
    title_zh: "机器级指令集架构，版本 1.13",
    title_unit_id: UID_PRIV_TITLE,
    sections: [
      {
        id: "sec-mstatus",
        level: 2,
        sectnum: "3.1.6",
        title_en: "Machine Status (mstatus and mstatush) Registers",
        title_zh: "机器状态寄存器（mstatus 与 mstatush）",
        heading_unit_id: UID_SEC_MSTATUS_H,
        heading_anchor_id: "mstatus-csr",
        blocks: [
          UID_MSTATUS_P1_V1,
          UID_MSTATUS_CODE,
        ],
      },
    ],
  },
  [STRUCT_PRIV_V2]: {
    struct_hash: STRUCT_PRIV_V2,
    volume_id: "priv",
    chapter_id: "machine",
    sectname: "chapter",
    sectnum: "3",
    title_en: "Machine-Level ISA, Version 1.13",
    title_zh: "机器级指令集架构，版本 1.13",
    title_unit_id: UID_PRIV_TITLE,
    sections: [
      {
        id: "sec-mstatus",
        level: 2,
        sectnum: "3.1.6",
        title_en: "Machine Status (mstatus and mstatush) Registers",
        title_zh: "机器状态寄存器（mstatus 与 mstatush）",
        heading_unit_id: UID_SEC_MSTATUS_H,
        heading_anchor_id: "mstatus-csr",
        blocks: [
          UID_MSTATUS_P1_V2,
          UID_MSTATUS_CODE,
        ],
      },
    ],
  },
};

export const DEMO_PACKS: Record<string, ChapterUnitPack> = {
  [PACK_RV32I_V1]: {
    pack_hash: PACK_RV32I_V1,
    volume_id: "unpriv",
    chapter_id: "rv32i",
    units: {
      [UID_RV32I_TITLE]: {
        unit_id: UID_RV32I_TITLE,
        kind: "heading",
        translatable: true,
        status: "approved",
        en_html: "RV32I Base Integer Instruction Set, Version 2.1",
        zh_html: "RV32I 基础整数指令集，版本 2.1",
      },
      [UID_SEC_INTRO_H]: {
        unit_id: UID_SEC_INTRO_H,
        kind: "heading",
        translatable: true,
        status: "approved",
        en_html: "Programmers' Model for Base Integer ISA",
        zh_html: "基础整数指令集的程序员模型",
      },
      [UID_INTRO_P1]: {
        unit_id: UID_INTRO_P1,
        kind: "paragraph",
        translatable: true,
        status: "approved",
        en_html:
          '<p>RV32I provides 32 general-purpose integer registers <code>x0</code>–<code>x31</code>, each <span class="rv-qty">32&#8239;bits</span> wide, with <code>x0</code> hardwired to zero.</p>',
        zh_html:
          '<p>RV32I 提供 32 个通用整数寄存器 <code>x0</code>–<code>x31</code>，每个位宽为 <span class="rv-qty">32&#8239;bits</span>，其中 <code>x0</code> 恒硬连线为零。</p>',
      },
      [UID_INTRO_NOTE]: {
        unit_id: UID_INTRO_NOTE,
        kind: "block",
        translatable: true,
        status: "approved",
        en_html:
          '<div class="admonitionblock note"><p>See <a class="xref-link" href="#mstatus-csr"><code>mstatus</code></a> for privileged execution modes.</p></div>',
        zh_html:
          '<div class="admonitionblock note"><p>有关特权执行模式，请参阅 <a class="xref-link" href="#mstatus-csr"><code>mstatus</code></a>。</p></div>',
      },
      [UID_FENCE_TSO]: {
        unit_id: UID_FENCE_TSO,
        kind: "paragraph",
        translatable: true,
        status: "approved",
        en_html:
          "<p><code>FENCE.TSO</code> orders all predecessor load operations before successor loads and stores.</p>",
        zh_html: "<p><code>FENCE.TSO</code> 保证所有前序访存读操作排在后序读/写操作之前。</p>",
      },
      [UID_SEC_ARITH_H]: {
        unit_id: UID_SEC_ARITH_H,
        kind: "heading",
        translatable: true,
        status: "approved",
        en_html: "Integer Register-Immediate Instructions",
        zh_html: "整数寄存器-立即数指令",
      },
      [UID_ADDI_P1_V1]: {
        unit_id: UID_ADDI_P1_V1,
        kind: "paragraph",
        translatable: true,
        status: "approved",
        en_html:
          "<p><code>ADDI</code> adds the sign-extended 12-bit immediate to register <code>rs1</code> and places the result in <code>rd</code>.</p>",
        zh_html:
          "<p><code>ADDI</code> 将符号扩展后的 12 位立即数与寄存器 <code>rs1</code> 相加，并将结果写入 <code>rd</code>。</p>",
      },
      [UID_MV_PSEUDO]: {
        unit_id: UID_MV_PSEUDO,
        kind: "paragraph",
        translatable: true,
        status: "approved",
        en_html: "<p><code>ADDI rd, rs1, 0</code> is used to implement the <code>MV</code> pseudoinstruction.</p>",
        zh_html: "<p><code>ADDI rd, rs1, 0</code> 用于实现 <code>MV</code> 伪指令。</p>",
      },
      [UID_LEGACY_NOTE]: {
        unit_id: UID_LEGACY_NOTE,
        kind: "block",
        translatable: true,
        status: "machine",
        en_html: "<div class=\"admonitionblock note\"><p>Older assemblers also accepted <code>LI</code> aliases.</p></div>",
        zh_html: "<div class=\"admonitionblock note\"><p>早期汇编器亦接受 <code>LI</code> 别名。</p></div>",
      },
    },
  },
  [PACK_RV32I_V2]: {
    pack_hash: PACK_RV32I_V2,
    volume_id: "unpriv",
    chapter_id: "rv32i",
    units: {
      [UID_RV32I_TITLE]: {
        unit_id: UID_RV32I_TITLE,
        kind: "heading",
        translatable: true,
        status: "approved",
        en_html: "RV32I Base Integer Instruction Set, Version 2.1",
        zh_html: "RV32I 基础整数指令集，版本 2.1",
      },
      [UID_SEC_INTRO_H]: {
        unit_id: UID_SEC_INTRO_H,
        kind: "heading",
        translatable: true,
        status: "approved",
        en_html: "Programmers' Model for Base Integer ISA",
        zh_html: "基础整数指令集的程序员模型",
      },
      [UID_INTRO_P1]: {
        unit_id: UID_INTRO_P1,
        kind: "paragraph",
        translatable: true,
        status: "approved",
        en_html:
          '<p>RV32I provides 32 general-purpose integer registers <code>x0</code>–<code>x31</code>, each <span class="rv-qty">32&#8239;bits</span> wide, with <code>x0</code> hardwired to zero.</p>',
        zh_html:
          '<p>RV32I 提供 32 个通用整数寄存器 <code>x0</code>–<code>x31</code>，每个位宽为 <span class="rv-qty">32&#8239;bits</span>，其中 <code>x0</code> 恒硬连线为零。</p>',
      },
      [UID_INTRO_NOTE]: {
        unit_id: UID_INTRO_NOTE,
        kind: "block",
        translatable: true,
        status: "approved",
        en_html:
          '<div class="admonitionblock note"><p>See <a class="xref-link" href="#mstatus-csr"><code>mstatus</code></a> for privileged execution modes.</p></div>',
        zh_html:
          '<div class="admonitionblock note"><p>有关特权执行模式，请参阅 <a class="xref-link" href="#mstatus-csr"><code>mstatus</code></a>。</p></div>',
      },
      [UID_FENCE_TSO]: {
        unit_id: UID_FENCE_TSO,
        kind: "paragraph",
        translatable: true,
        status: "approved",
        en_html:
          "<p><code>FENCE.TSO</code> orders all predecessor load operations before successor loads and stores.</p>",
        zh_html: "<p><code>FENCE.TSO</code> 保证所有前序访存读操作排在后序读/写操作之前。</p>",
      },
      [UID_SEC_ARITH_H]: {
        unit_id: UID_SEC_ARITH_H,
        kind: "heading",
        translatable: true,
        status: "approved",
        en_html: "Integer Register-Immediate Instructions",
        zh_html: "整数寄存器-立即数指令",
      },
      [UID_ADDI_P1_V2]: {
        unit_id: UID_ADDI_P1_V2,
        kind: "paragraph",
        translatable: true,
        status: "machine",
        prev_unit_id: UID_ADDI_P1_V1,
        en_html:
          "<p><code>ADDI</code> adds the sign-extended 12-bit immediate to register <code>rs1</code>. Arithmetic overflow is ignored and the result is the low XLEN bits.</p>",
        zh_html:
          "<p><code>ADDI</code> 将符号扩展后的 12 位立即数与寄存器 <code>rs1</code> 相加。算术溢出将被忽略，结果取低 XLEN 位。</p>",
      },
      [UID_MV_PSEUDO]: {
        unit_id: UID_MV_PSEUDO,
        kind: "paragraph",
        translatable: true,
        status: "approved",
        en_html: "<p><code>ADDI rd, rs1, 0</code> is used to implement the <code>MV</code> pseudoinstruction.</p>",
        zh_html: "<p><code>ADDI rd, rs1, 0</code> 用于实现 <code>MV</code> 伪指令。</p>",
      },
      [UID_ZICOND_NEW]: {
        unit_id: UID_ZICOND_NEW,
        kind: "paragraph",
        translatable: true,
        status: "untranslated",
        en_html:
          "<p>Standard extension <code>Zicond</code> builds upon base integer operations to eliminate conditional branches.</p>",
      },
    },
  },
  [PACK_PRIV_V1]: {
    pack_hash: PACK_PRIV_V1,
    volume_id: "priv",
    chapter_id: "machine",
    units: {
      [UID_PRIV_TITLE]: {
        unit_id: UID_PRIV_TITLE,
        kind: "heading",
        translatable: true,
        status: "approved",
        en_html: "Machine-Level ISA, Version 1.13",
        zh_html: "机器级指令集架构，版本 1.13",
      },
      [UID_SEC_MSTATUS_H]: {
        unit_id: UID_SEC_MSTATUS_H,
        kind: "heading",
        translatable: true,
        status: "approved",
        en_html: "Machine Status (mstatus and mstatush) Registers",
        zh_html: "机器状态寄存器（mstatus 与 mstatush）",
      },
      [UID_MSTATUS_P1_V1]: {
        unit_id: UID_MSTATUS_P1_V1,
        kind: "paragraph",
        translatable: true,
        status: "approved",
        en_html:
          '<p>The <code>mstatus</code> register keeps track of the <a class="xref-link" href="#insns-addi">hart\'s</a> current operating state.</p>',
        zh_html:
          '<p><code>mstatus</code> 寄存器用于跟踪 <a class="xref-link" href="#insns-addi">硬件线程</a> 当前的运行状态。</p>',
      },
      [UID_MSTATUS_CODE]: {
        unit_id: UID_MSTATUS_CODE,
        kind: "code",
        translatable: false,
        en_html: "<pre><code>// mstatus.MPRV controls memory privilege level\ncsrr t0, mstatus</code></pre>",
      },
    },
  },
  [PACK_PRIV_V2]: {
    pack_hash: PACK_PRIV_V2,
    volume_id: "priv",
    chapter_id: "machine",
    units: {
      [UID_PRIV_TITLE]: {
        unit_id: UID_PRIV_TITLE,
        kind: "heading",
        translatable: true,
        status: "approved",
        en_html: "Machine-Level ISA, Version 1.13",
        zh_html: "机器级指令集架构，版本 1.13",
      },
      [UID_SEC_MSTATUS_H]: {
        unit_id: UID_SEC_MSTATUS_H,
        kind: "heading",
        translatable: true,
        status: "approved",
        en_html: "Machine Status (mstatus and mstatush) Registers",
        zh_html: "机器状态寄存器（mstatus 与 mstatush）",
      },
      [UID_MSTATUS_P1_V2]: {
        unit_id: UID_MSTATUS_P1_V2,
        kind: "paragraph",
        translatable: true,
        status: "machine",
        prev_unit_id: UID_MSTATUS_P1_V1,
        en_html:
          '<p>The <code>mstatus</code> register keeps track of and controls the hart\'s current operating state, including explicit <code>MPRV</code> privilege modification for <a class="xref-link" href="#insns-addi">base integer</a> loads and stores.</p>',
        zh_html:
          '<p><code>mstatus</code> 寄存器用于跟踪并控制硬件线程当前的运行状态，包含面向 <a class="xref-link" href="#insns-addi">基础整数</a> 访存指令的 <code>MPRV</code> 特权级控制。</p>',
      },
      [UID_MSTATUS_CODE]: {
        unit_id: UID_MSTATUS_CODE,
        kind: "code",
        translatable: false,
        en_html: "<pre><code>// mstatus.MPRV controls memory privilege level\ncsrr t0, mstatus</code></pre>",
      },
    },
  },
};

export const DEMO_ANCHORS: AnchorIndex = {
  anchors: {
    "sec-intro": {
      volume_id: "unpriv",
      chapter_id: "rv32i",
      section_id: "sec-intro",
      anchor_id: "sec-intro",
    },
    "xlen-32": {
      volume_id: "unpriv",
      chapter_id: "rv32i",
      section_id: "sec-intro",
      anchor_id: "xlen-32",
    },
    "fence-tso": {
      volume_id: "unpriv",
      chapter_id: "rv32i",
      section_id: "sec-arith",
      anchor_id: "fence-tso",
    },
    "insns-addi": {
      volume_id: "unpriv",
      chapter_id: "rv32i",
      section_id: "sec-arith",
      anchor_id: "insns-addi",
    },
    "norm:addi_op": {
      volume_id: "unpriv",
      chapter_id: "rv32i",
      section_id: "sec-arith",
      anchor_id: "insns-addi",
    },
    "mstatus-csr": {
      volume_id: "priv",
      chapter_id: "machine",
      section_id: "sec-mstatus",
      anchor_id: "mstatus-csr",
    },
  },
};

const ALL_DEMO_META: UnitMeta[] = [
  {
    unit_id: UID_INTRO_P1,
    kind: "paragraph",
    translatable: true,
    status: "approved",
    en_raw:
      "RV32I provides 32 general-purpose integer registers `x0`–`x31`, each qty:32[bits] wide, with `x0` hardwired to zero.",
    zh_raw:
      "RV32I 提供 32 个通用整数寄存器 `x0`–`x31`，每个位宽为 qty:32[bits]，其中 `x0` 恒硬连线为零。",
    origin_hint: "unpriv/rv32i/sec-intro",
    upstream_history: [
      {
        sha: SHA_V1,
        date: "2026-01-12T08:00:00Z",
        title: "docs: ratify Unprivileged Spec 20250112 baseline",
        ratified_tag: "20250112",
        change_kind: "baseline",
        unit_id: UID_INTRO_P1,
      },
    ],
    revisions: [
      {
        commit_sha: "abc0001",
        date: "2026-01-15T10:00:00Z",
        author: "translator",
        message: "人工审校并调整数量词格式",
        status: "approved",
        zh: "RV32I 提供 32 个通用整数寄存器 `x0`–`x31`，每个位宽为 qty:32[bits]，其中 `x0` 恒硬连线为零。",
      },
    ],
  },
  {
    unit_id: UID_ADDI_P1_V2,
    kind: "paragraph",
    translatable: true,
    status: "machine",
    en_raw:
      "`ADDI` adds the sign-extended 12-bit immediate to register `rs1`. Arithmetic overflow is ignored and the result is the low XLEN bits.",
    zh_raw:
      "`ADDI` 将符号扩展后的 12 位立即数与寄存器 `rs1` 相加。算术溢出将被忽略，结果取低 XLEN 位。",
    origin_hint: "unpriv/rv32i/sec-arith",
    prev_unit_id: UID_ADDI_P1_V1,
    upstream_history: [
      {
        sha: SHA_V1,
        date: "2026-01-12T08:00:00Z",
        title: "docs: ratify Unprivileged Spec 20250112 baseline",
        ratified_tag: "20250112",
        change_kind: "baseline",
        unit_id: UID_ADDI_P1_V1,
      },
      {
        sha: SHA_V2,
        date: "2026-02-01T14:30:00Z",
        title: "RV32I & Priv: clarify ADDI overflow wording, move FENCE.TSO, update mstatus.MPRV",
        ratified_tag: null,
        change_kind: "modified",
        unit_id: UID_ADDI_P1_V2,
        prev_unit_id: UID_ADDI_P1_V1,
      },
    ],
    revisions: [
      {
        commit_sha: "def0002",
        date: "2026-02-01T14:40:00Z",
        author: "translator-bot",
        message: "机器同步译文：更新 ADDI 溢出说明",
        status: "machine",
        zh: "`ADDI` 将符号扩展后的 12 位立即数与寄存器 `rs1` 相加。算术溢出将被忽略，结果取低 XLEN 位。",
      },
    ],
  },
  {
    unit_id: UID_FENCE_TSO,
    kind: "paragraph",
    translatable: true,
    status: "approved",
    en_raw: "`FENCE.TSO` orders all predecessor load operations before successor loads and stores.",
    zh_raw: "`FENCE.TSO` 保证所有前序访存读操作排在后序读/写操作之前。",
    origin_hint: "unpriv/rv32i/sec-arith",
    upstream_history: [
      {
        sha: SHA_V1,
        date: "2026-01-12T08:00:00Z",
        title: "docs: ratify Unprivileged Spec 20250112 baseline",
        ratified_tag: "20250112",
        change_kind: "baseline",
        unit_id: UID_FENCE_TSO,
      },
      {
        sha: SHA_V2,
        date: "2026-02-01T14:30:00Z",
        title: "RV32I & Priv: clarify ADDI overflow wording, move FENCE.TSO, update mstatus.MPRV",
        ratified_tag: null,
        change_kind: "moved",
        unit_id: UID_FENCE_TSO,
        moved_from: "2.1 Programmers' Model for Base Integer ISA",
      },
    ],
    revisions: [
      {
        commit_sha: "abc0001",
        date: "2026-01-15T10:00:00Z",
        author: "translator",
        message: "人工审校 FENCE.TSO 译文",
        status: "approved",
        zh: "`FENCE.TSO` 保证所有前序访存读操作排在后序读/写操作之前。",
      },
    ],
  },
  {
    unit_id: UID_ZICOND_NEW,
    kind: "paragraph",
    translatable: true,
    status: "untranslated",
    en_raw:
      "Standard extension ext:Zicond[] builds upon base integer operations to eliminate conditional branches.",
    origin_hint: "unpriv/rv32i/sec-arith",
    upstream_history: [
      {
        sha: SHA_V2,
        date: "2026-02-01T14:30:00Z",
        title: "RV32I & Priv: clarify ADDI overflow wording, move FENCE.TSO, update mstatus.MPRV",
        ratified_tag: null,
        change_kind: "added",
        unit_id: UID_ZICOND_NEW,
      },
    ],
    revisions: [],
  },
  {
    unit_id: UID_MSTATUS_P1_V2,
    kind: "paragraph",
    translatable: true,
    status: "machine",
    en_raw:
      "The csr:mstatus[] register keeps track of and controls the hart's current operating state, including explicit `MPRV` privilege modification for <<insns-addi,base integer>> loads and stores.",
    zh_raw:
      "csr:mstatus[] 寄存器用于跟踪并控制硬件线程当前的运行状态，包含面向 <<insns-addi,基础整数>> 访存指令的 `MPRV` 特权级控制。",
    origin_hint: "priv/machine/sec-mstatus",
    prev_unit_id: UID_MSTATUS_P1_V1,
    upstream_history: [
      {
        sha: SHA_V1,
        date: "2026-01-12T08:00:00Z",
        title: "docs: ratify Unprivileged Spec 20250112 baseline",
        ratified_tag: "20250112",
        change_kind: "baseline",
        unit_id: UID_MSTATUS_P1_V1,
      },
      {
        sha: SHA_V2,
        date: "2026-02-01T14:30:00Z",
        title: "RV32I & Priv: clarify ADDI overflow wording, move FENCE.TSO, update mstatus.MPRV",
        ratified_tag: null,
        change_kind: "modified",
        unit_id: UID_MSTATUS_P1_V2,
        prev_unit_id: UID_MSTATUS_P1_V1,
      },
    ],
    revisions: [
      {
        commit_sha: "def0003",
        date: "2026-02-01T14:45:00Z",
        author: "translator-bot",
        message: "机器同步译文：更新 mstatus.MPRV 描述",
        status: "machine",
        zh: "csr:mstatus[] 寄存器用于跟踪并控制硬件线程当前的运行状态，包含面向 <<insns-addi,基础整数>> 访存指令的 `MPRV` 特权级控制。",
      },
    ],
  },
];

export const DEMO_META_SHARDS: Record<string, UnitMetaShard> = ALL_DEMO_META.reduce<
  Record<string, UnitMetaShard>
>((acc, meta) => {
  const prefix = meta.unit_id.slice(0, 2);
  if (!acc[prefix]) acc[prefix] = {};
  acc[prefix][meta.unit_id] = meta;
  return acc;
}, {});

export const DEMO_SEARCH_ENTRIES: SearchEntry[] = [
  {
    unit_id: UID_SEC_ARITH_H,
    volume_id: "unpriv",
    chapter_id: "rv32i",
    section_id: "sec-arith",
    chapter_title: "RV32I Base Integer Instruction Set, Version 2.1",
    chapter_title_zh: "RV32I 基础整数指令集，版本 2.1",
    section_title: "Integer Register-Immediate Instructions",
    section_title_zh: "整数寄存器-立即数指令",
    kind: "heading",
    en: "Integer Register-Immediate Instructions",
    zh: "整数寄存器-立即数指令",
    anchor_id: "insns-addi",
    extra_anchors: ["norm:addi_op"],
  },
  {
    unit_id: UID_ADDI_P1_V2,
    volume_id: "unpriv",
    chapter_id: "rv32i",
    section_id: "sec-arith",
    chapter_title: "RV32I Base Integer Instruction Set, Version 2.1",
    chapter_title_zh: "RV32I 基础整数指令集，版本 2.1",
    section_title: "Integer Register-Immediate Instructions",
    section_title_zh: "整数寄存器-立即数指令",
    kind: "paragraph",
    en: "ADDI adds the sign-extended 12-bit immediate to register rs1. Arithmetic overflow is ignored and the result is the low XLEN bits.",
    zh: "ADDI 将符号扩展后的 12 位立即数与寄存器 rs1 相加。算术溢出将被忽略，结果取低 XLEN 位。",
    symbols: ["ADDI", "rs1", "XLEN"],
    anchor_id: "insns-addi",
  },
  {
    unit_id: UID_MSTATUS_P1_V2,
    volume_id: "priv",
    chapter_id: "machine",
    section_id: "sec-mstatus",
    chapter_title: "Machine-Level ISA, Version 1.13",
    chapter_title_zh: "机器级指令集架构，版本 1.13",
    section_title: "Machine Status (mstatus and mstatush) Registers",
    section_title_zh: "机器状态寄存器（mstatus 与 mstatush）",
    kind: "paragraph",
    en: "The mstatus register keeps track of and controls the hart's current operating state, including explicit MPRV privilege modification.",
    zh: "mstatus 寄存器用于跟踪并控制硬件线程当前的运行状态，包含 MPRV 特权级控制。",
    symbols: ["mstatus", "MPRV"],
    anchor_id: "mstatus-csr",
  },
];
