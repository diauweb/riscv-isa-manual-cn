import { APICallError, NoObjectGeneratedError, RetryError } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  defaultModelForProvider,
  estimateTokens,
  parseUnitFenceTranslations,
  resolveProvider,
  salvageTruncatedTranslations,
  setGenerateObjectForTest,
  translateChapterBatch,
  validateTranslationStructure,
  type GenerateTranslationCallOptions,
  type LlmCallProgressEvent,
} from "../src/translate/index.ts";
import {
  resolveLangSmithConfig,
  setLangSmithFetchForTest,
} from "../src/translate/langsmith.ts";

const UNIT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const UNIT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const prevAiProvider = process.env.AI_PROVIDER;
const prevAiModel = process.env.AI_MODEL;
const prevAiBaseUrl = process.env.AI_BASE_URL;
const prevDeepseekBaseUrl = process.env.DEEPSEEK_BASE_URL;
const prevDeepseekKey = process.env.DEEPSEEK_API_KEY;
const prevOpenAiKey = process.env.OPENAI_API_KEY;
const prevLangSmithTracing = process.env.LANGSMITH_TRACING;
const prevLangSmithApiKey = process.env.LANGSMITH_API_KEY;
const prevLangSmithProject = process.env.LANGSMITH_PROJECT;
const prevLangSmithEndpoint = process.env.LANGSMITH_ENDPOINT;

beforeEach(() => {
  delete process.env.AI_PROVIDER;
  delete process.env.AI_MODEL;
  delete process.env.AI_BASE_URL;
  delete process.env.DEEPSEEK_BASE_URL;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LANGSMITH_TRACING;
  delete process.env.LANGSMITH_API_KEY;
  delete process.env.LANGSMITH_PROJECT;
  delete process.env.LANGSMITH_ENDPOINT;
});

afterEach(() => {
  setGenerateObjectForTest(undefined);
  setLangSmithFetchForTest(undefined);
  if (prevAiProvider === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = prevAiProvider;
  if (prevAiModel === undefined) delete process.env.AI_MODEL;
  else process.env.AI_MODEL = prevAiModel;
  if (prevAiBaseUrl === undefined) delete process.env.AI_BASE_URL;
  else process.env.AI_BASE_URL = prevAiBaseUrl;
  if (prevDeepseekBaseUrl === undefined) delete process.env.DEEPSEEK_BASE_URL;
  else process.env.DEEPSEEK_BASE_URL = prevDeepseekBaseUrl;
  if (prevDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = prevDeepseekKey;
  if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevOpenAiKey;
  if (prevLangSmithTracing === undefined) delete process.env.LANGSMITH_TRACING;
  else process.env.LANGSMITH_TRACING = prevLangSmithTracing;
  if (prevLangSmithApiKey === undefined) delete process.env.LANGSMITH_API_KEY;
  else process.env.LANGSMITH_API_KEY = prevLangSmithApiKey;
  if (prevLangSmithProject === undefined) delete process.env.LANGSMITH_PROJECT;
  else process.env.LANGSMITH_PROJECT = prevLangSmithProject;
  if (prevLangSmithEndpoint === undefined) delete process.env.LANGSMITH_ENDPOINT;
  else process.env.LANGSMITH_ENDPOINT = prevLangSmithEndpoint;
});

describe("validateTranslationStructure", () => {
  it("passes when backticks, xrefs, and math are preserved", () => {
    const en =
      "In RV32I, `ADD` writes `x1` using 12 bits and offset 0x1f; see <<sec-add>> and stem:[x + 1] or latexmath:[\\frac{a}{b}].";
    const zh =
      "在 RV32I 中，`ADD` 使用 12 位和偏移量 0x1f 写入 `x1`；参见 <<sec-add,加法指令>> 以及 stem:[x + 1] 或 latexmath:[\\frac{a}{b}]。";
    const res = validateTranslationStructure(en, zh);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("catches dropped inline backticks such as `XLEN` or `x1`", () => {
    const en = "Register `x1` has width `XLEN`.";
    const zh = "寄存器 x1 的宽度为 `XLEN`。";
    const res = validateTranslationStructure(en, zh);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("`x1`"))).toBe(true);
  });

  it("catches dropped or altered <<xref>> targets", () => {
    const en = "Refer to <<norm:add_ovf>> for details.";
    const zh = "详情参见 <<add_ovf>>。";
    const res = validateTranslationStructure(en, zh);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("norm:add_ovf"))).toBe(true);
  });

  it("catches dropped stem/latexmath expressions", () => {
    const en = "Compute stem:[2^32 - 1] and latexmath:[a \\le b].";
    const zh = "计算 stem:[2^32 - 1] 和 a <= b。";
    const res = validateTranslationStructure(en, zh);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("latexmath:[a \\le b]"))).toBe(true);
  });

  it("checks RISC-V custom inline macros and rejects leading =+ markers on headings", () => {
    const macroEn = "Execute insn:czero.eqz[rd, rs1, rs2] across qty:32[bits] with csr:mstatus[].";
    expect(
      validateTranslationStructure(
        macroEn,
        "使用 csr:mstatus[] 在 qty:32[bits] 位宽下执行 insn:czero.eqz[rd, rs1, rs2]。",
      ).ok,
    ).toBe(true);
    expect(
      validateTranslationStructure(
        macroEn,
        "使用 csr:mstatus[] 执行 czero.eqz。",
      ).ok,
    ).toBe(false);

    expect(validateTranslationStructure("Overview", "== 概述", "heading").ok).toBe(false);
    expect(validateTranslationStructure("Overview", "概述", "heading").ok).toBe(true);
  });

  it("handles unconstrained ``...`` spans followed by `...` spans on the same line", () => {
    const en =
      "[#norm:pmp_a_field_tor]#If TOR is selected, the entry matches any address _y_ such that `pmpaddr~i-1~`{le}__y__<``pmpaddr~i~`` (irrespective of the value of `pmpcfg~i-1~`). If PMP entry 0's A field is set to TOR, it matches `y<pmpaddr~0~`.#";
    const zhOkDouble =
      "[#norm:pmp_a_field_tor]#如果选择 TOR，则该条目匹配满足 `pmpaddr~i-1~`{le}__y__<``pmpaddr~i~``（无论 `pmpcfg~i-1~` 的值如何）的任意地址 _y_。如果 PMP 条目 0 的 A 字段设为 TOR，则匹配 `y<pmpaddr~0~`。#";
    const zhOkSingle =
      "[#norm:pmp_a_field_tor]#如果选择 TOR，则该条目匹配满足 `pmpaddr~i-1~`{le}__y__<`pmpaddr~i~`（无论 `pmpcfg~i-1~` 的值如何）的任意地址 _y_。如果 PMP 条目 0 的 A 字段设为 TOR，则匹配 `y<pmpaddr~0~`。#";
    const zhMissing =
      "[#norm:pmp_a_field_tor]#如果选择 TOR，则该条目匹配满足 `pmpaddr~i-1~`{le}__y__<``pmpaddr~i~``（无论 pmpcfg~i-1~ 的值如何）的任意地址 _y_。如果 PMP 条目 0 的 A 字段设为 TOR，则匹配 `y<pmpaddr~0~`。#";

    expect(validateTranslationStructure(en, zhOkDouble)).toEqual({ ok: true, errors: [] });
    expect(validateTranslationStructure(en, zhOkSingle)).toEqual({ ok: true, errors: [] });
    const missingRes = validateTranslationStructure(en, zhMissing);
    expect(missingRes.ok).toBe(false);
    expect(missingRes.errors).toEqual(["Missing inline code span: `pmpcfg~i-1~`"]);
  });

  it("handles mixed single and double backticks across line breaks when unwrapped into one Chinese line", () => {
    const en = [
      "[#norm:Zicsr_debug_range]#Machine-mode standard read-write CSRs `0x7A0`{endash}``0x7BF`` are reserved for",
      "use by the debug system. Of these CSRs, `0x7A0`{endash}``0x7AF`` are accessible",
      "to machine mode, whereas#",
      "[#norm:Zicsr_debug_illegal]#`0x7B0`{endash}``0x7BF`` are only visible to debug mode.#",
    ].join("\n");
    const zhMixed =
      "[#norm:Zicsr_debug_range]#机器模式的标准读写 CSR `0x7A0`{endash}``0x7BF`` 保留供调试系统使用。在这些 CSR 中，`0x7A0`{endash}``0x7AF`` 可由机器模式访问，而# [#norm:Zicsr_debug_illegal]#`0x7B0`{endash}``0x7BF`` 仅对调试模式可见。#";
    const zhDouble =
      "[#norm:Zicsr_debug_range]#机器模式的标准读写 CSR ``0x7A0``{endash}``0x7BF`` 保留供调试系统使用。在这些 CSR 中，``0x7A0``{endash}``0x7AF`` 可由机器模式访问，而# [#norm:Zicsr_debug_illegal]#``0x7B0``{endash}``0x7BF`` 仅对调试模式可见。#";

    expect(validateTranslationStructure(en, zhMixed)).toEqual({ ok: true, errors: [] });
    expect(validateTranslationStructure(en, zhDouble)).toEqual({ ok: true, errors: [] });
  });

  it("treats single-line and multi-line AsciiDoc curved quotes as prose while still checking real code spans", () => {
    const en =
      'These instructions implement a "`lookup table`" for the "`predecessor\nset`" and \'`word`\' using `x1`.';
    const zhOk = "这些指令使用 `x1` 为“查找表”以及“前驱集”和‘词’实现功能。";
    const zhMissingCode = "这些指令使用 x1 为“查找表”以及“前驱集”和‘词’实现功能。";

    expect(validateTranslationStructure(en, zhOk)).toEqual({ ok: true, errors: [] });
    const missingRes = validateTranslationStructure(en, zhMissingCode);
    expect(missingRes.ok).toBe(false);
    expect(missingRes.errors).toEqual(["Missing inline code span: `x1`"]);
  });

  it("ignores triple-backtick fenced blocks and legacy LaTeX ``...'' quotes", () => {
    const en = [
      "[NOTE]",
      "====",
      "The ``PC'' is saved when `a0`=1:",
      "",
      "```",
      "li t1, 0x4585 # comment with `backtick`",
      "```",
      "====",
    ].join("\n");
    const zhOk = [
      "[NOTE]",
      "====",
      "当 `a0`=1 时，“PC”会被保存：",
      "",
      "```",
      "li t1, 0x4585 # 含 `backtick` 的注释",
      "```",
      "====",
    ].join("\n");

    expect(validateTranslationStructure(en, zhOk, "block")).toEqual({ ok: true, errors: [] });
  });

  it("canonicalizes inst: aliases and hyphen-prefixed ext macros, and rejects hybrid quote+backtick spans", () => {
    expect(
      validateTranslationStructure(
        "Execute inst:fence.i[] before continuing.",
        "在继续之前执行 insn:fence.i[]。",
      ),
    ).toEqual({ ok: true, errors: [] });

    expect(
      validateTranslationStructure(
        "Compatible with non-ext:ziccid[] and pre-ext:ziccid[] semantics.",
        "兼容非 ext:ziccid[] 机器和 ext:ziccid[] 之前的语义。",
      ),
    ).toEqual({ ok: true, errors: [] });

    const hybridBad = validateTranslationStructure(
      'After the "`Arbitrary unrelated\nload`" with `x1`.',
      "在“`任意无关加载`”并使用 `x1` 之后。",
    );
    expect(hybridBad.ok).toBe(false);
    expect(hybridBad.errors).toEqual([
      "Malformed curved quote around non-code text (“`任意无关加载`”): use Chinese quotes (“...” / ‘...’) without backticks.",
    ]);

    expect(
      validateTranslationStructure(
        "Register `x1` is referenced.",
        "引用了寄存器“`x1`”。",
      ),
    ).toEqual({ ok: true, errors: [] });
  });
});

describe("translateChapterBatch", () => {
  it("translates deterministically with mock provider while preserving AsciiDoc structure", async () => {
    const out = await translateChapterBatch({
      glossaryMarkdown: "# Glossary\n- `hart` -> 硬件线程",
      chapterTitle: "RV32I Base Integer Instruction Set",
      chapterBlocks: [
        { unit_id: UNIT_A, en: "Overview", zh: "[ZH] Overview", status: "approved" },
        { unit_id: UNIT_B, en: "Add 12 and `x1` with 0x1f; see <<sec-1>>." },
      ],
      targets: [
        {
          unit_id: UNIT_B,
          en: "Add 12 and `x1` with 0x1f; see <<sec-1>>.",
          kind: "paragraph",
          prev_en: "Add 8 and `x1` with 0x1f; see <<sec-1>>.",
          prev_zh: "将 8 与 `x1` 和 0x1f 相加；参见 <<sec-1>>。",
        },
      ],
      provider: "mock",
    });

    const entry = out.get(UNIT_B);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("machine");
    expect(validateTranslationStructure("Add 12 and `x1` with 0x1f; see <<sec-1>>.", entry!.zh).ok).toBe(
      true,
    );
  });

  it("retries failed structural validations up to 2 times via multi-turn <error> follow-up", async () => {
    let calls = 0;
    const snapshots: Array<{ system: string; messages: GenerateTranslationCallOptions["messages"] }> = [];

    setGenerateObjectForTest(async (opts) => {
      calls++;
      snapshots.push({
        system: opts.system,
        messages: opts.messages.map((m) => ({ ...m })),
      });
      expect(opts.system).toContain('<rule_file name="GLOSSARY.md">');
      expect(opts.system).toContain('<translation id="');

      if (calls === 1) {
        // Invalid on first attempt: drops `x1` and 0x1f
        return {
          object: {
            translations: [{ unit_id: UNIT_B, zh: "使用寄存器和掩码。" }],
          },
        };
      }
      // Valid on retry
      return {
        object: {
          translations: [{ unit_id: UNIT_B, zh: "使用 `x1` 和掩码 0x1f。" }],
        },
      };
    });

    const out = await translateChapterBatch({
      glossaryMarkdown: "- `x1` -> `x1`",
      chapterTitle: "Chapter 1",
      chapterBlocks: [
        { unit_id: UNIT_A, kind: "heading", en: "Overview", zh: "概述", status: "approved" },
        {
          unit_id: "cccccccccccccccccccccccccccccccc",
          kind: "code",
          en: "[source,asm]\n----\naddi x1, x0, 1\n----",
          zh: "[source,asm]\n----\naddi x1, x0, 1\n----",
          status: "approved",
        },
        { unit_id: UNIT_B, kind: "paragraph", en: "Use `x1` and mask 0x1f." },
      ],
      targets: [{ unit_id: UNIT_B, en: "Use `x1` and mask 0x1f.", kind: "paragraph" }],
      provider: "google",
    });

    expect(calls).toBe(2);
    expect(snapshots[0].messages).toHaveLength(1);
    expect(snapshots[0].messages[0].role).toBe("user");
    expect(snapshots[0].messages[0].content).toContain("== Overview\n== 概述");
    expect(snapshots[0].messages[0].content).toContain("[source,asm]\n----\naddi x1, x0, 1\n----");
    expect(snapshots[0].messages[0].content).toContain(
      `<unit id="${UNIT_B}" kind="paragraph">\nUse \`x1\` and mask 0x1f.\n</unit>`,
    );

    expect(snapshots[1].messages).toHaveLength(3);
    expect(snapshots[1].messages[1]).toEqual({
      role: "assistant",
      content: `<translation id="${UNIT_B}">\n使用寄存器和掩码。\n</translation>`,
    });
    expect(snapshots[1].messages[2].role).toBe("user");
    expect(snapshots[1].messages[2].content).toContain(
      "The following units did not pass validation, please output a new version of the translation of ONLY these units and fix the error.",
    );
    expect(snapshots[1].messages[2].content).toContain(`<error unit_id="${UNIT_B}">`);
    expect(snapshots[1].messages[2].content).toContain("`x1`");
    expect(out.get(UNIT_B)).toEqual({
      zh: "使用 `x1` 和掩码 0x1f。",
      status: "machine",
    });
  });

  it("retries only failed units in round 2 when other targets pass round 1", async () => {
    let calls = 0;
    const roundPrompts: string[] = [];

    setGenerateObjectForTest(async (opts) => {
      calls++;
      roundPrompts.push(opts.messages[opts.messages.length - 1].content);
      if (calls === 1) {
        return {
          object: {
            translations: [
              { unit_id: UNIT_A, zh: "== 概述" },
              { unit_id: UNIT_B, zh: "使用寄存器。" }, // drops `x1`
            ],
          },
        };
      }
      return {
        object: {
          translations: [{ unit_id: UNIT_B, zh: "使用 `x1`。" }],
        },
      };
    });

    const out = await translateChapterBatch({
      glossaryMarkdown: "- `x1` -> `x1`",
      chapterTitle: "Chapter 1",
      chapterBlocks: [
        { unit_id: UNIT_A, kind: "heading", en: "Overview" },
        { unit_id: UNIT_B, kind: "paragraph", en: "Use `x1`." },
      ],
      targets: [
        { unit_id: UNIT_A, en: "Overview", kind: "heading" },
        { unit_id: UNIT_B, en: "Use `x1`.", kind: "paragraph" },
      ],
      provider: "deepseek",
    });

    expect(calls).toBe(2);
    expect(roundPrompts[0]).toContain(`<unit id="${UNIT_A}" kind="heading">`);
    expect(roundPrompts[0]).toContain(`<unit id="${UNIT_B}" kind="paragraph">`);
    expect(roundPrompts[1]).toContain(`<error unit_id="${UNIT_B}">`);
    expect(roundPrompts[1]).not.toContain(UNIT_A);
    // Accidental leading `== ` returned by LLM on headings is stripped cleanly
    expect(out.get(UNIT_A)).toEqual({ zh: "概述", status: "machine" });
    expect(out.get(UNIT_B)).toEqual({ zh: "使用 `x1`。", status: "machine" });
  });

  it("sends exact XML system prompt over HTTP SSE stream, parses XML <translation> fences, and reports live ~tokens + final exact tokens", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    const originalFetch = globalThis.fetch;
    const wireBodies: Array<Record<string, unknown>> = [];
    const progressEvents: LlmCallProgressEvent[] = [];
    let attempt = 0;

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      attempt++;
      wireBodies.push(JSON.parse(String(init?.body ?? "{}")));
      const content =
        attempt === 1
          ? `<translation id="${UNIT_B}">\n缺少代码格式。\n</translation>`
          : "```xml\n" + `<translation id="${UNIT_B}">\n使用 \`x1\`。\n</translation>` + "\n```";
      const mid = Math.floor(content.length / 2);
      const part1 = content.slice(0, mid);
      const part2 = content.slice(mid);
      const ssePayload = [
        `data: ${JSON.stringify({
          id: `chatcmpl-${attempt}`,
          object: "chat.completion.chunk",
          created: 1700000000,
          model: "deepseek-chat",
          choices: [{ index: 0, delta: { role: "assistant", content: part1 }, finish_reason: null }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: `chatcmpl-${attempt}`,
          object: "chat.completion.chunk",
          created: 1700000000,
          model: "deepseek-chat",
          choices: [{ index: 0, delta: { content: part2 }, finish_reason: "stop" }],
          // Attempt 1 includes token usage; Attempt 2 omits usage to verify char fallback
          ...(attempt === 1
            ? { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }
            : {}),
        })}\n\n`,
        "data: [DONE]\n\n",
      ].join("");

      return new Response(ssePayload, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const out = await translateChapterBatch({
        glossaryMarkdown: "- `x1` -> `x1`",
        chapterTitle: "Chapter 1",
        chapterBlocks: [{ unit_id: UNIT_B, kind: "paragraph", en: "Use `x1`." }],
        targets: [{ unit_id: UNIT_B, en: "Use `x1`.", kind: "paragraph" }],
        provider: "deepseek",
        baseUrl: "https://mock-wire.example.test/v1",
        maxInputTokens: 50_000,
        maxOutputTokens: 12_000,
        onLlmProgress: (event) => progressEvents.push(event),
      });

      expect(out.get(UNIT_B)).toEqual({ zh: "使用 `x1`。", status: "machine" });
      expect(wireBodies).toHaveLength(2);
      expect(wireBodies[0].stream).toBe(true);
      expect(wireBodies[0].response_format).toBeUndefined();
      expect(wireBodies[0].max_tokens).toBeUndefined();
      expect(wireBodies[0].max_completion_tokens).toBeUndefined();

      const msgs1 = wireBodies[0].messages as Array<{ role: string; content: string }>;
      expect(msgs1.map((m) => m.role)).toEqual(["system", "user"]);
      expect(msgs1[0].content).toContain('<rule_file name="GLOSSARY.md">');
      expect(msgs1[0].content).toMatch(/<\/translation>$/);

      const msgs2 = wireBodies[1].messages as Array<{ role: string; content: string }>;
      expect(msgs2.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
      expect(msgs2[0].content).toBe(msgs1[0].content);
      expect(msgs2[3].content).toContain(`<error unit_id="${UNIT_B}">`);

      // Verify uploading -> waiting -> stream -> finish lifecycle and exact vs estimated tokens
      expect(progressEvents.filter((e) => e.phase === "uploading")).toHaveLength(2);
      expect(progressEvents.filter((e) => e.phase === "waiting")).toHaveLength(2);
      expect(
        progressEvents
          .filter((e) => e.phase === "uploading")
          .every((e) => !e.exactInput && e.inputTokens > 0 && e.outputTokens === 0),
      ).toBe(true);
      const streamEvents = progressEvents.filter((e) => e.phase === "stream");
      expect(streamEvents.length).toBeGreaterThanOrEqual(4);
      expect(
        streamEvents.every(
          (e) => !e.exactInput && e.inputTokens > 0 && !e.exactOutput && e.outputTokens > 0,
        ),
      ).toBe(true);
      const finishEvents = progressEvents.filter((e) => e.phase === "finish");
      expect(finishEvents).toHaveLength(2);
      expect(finishEvents[0].exactInput).toBe(true);
      expect(finishEvents[0].inputTokens).toBe(100);
      expect(finishEvents[0].exactOutput).toBe(true);
      expect(finishEvents[0].outputTokens).toBe(20);
      expect(finishEvents[1].exactInput).toBe(false);
      expect(finishEvents[1].inputTokens).toBeGreaterThan(0);
      expect(finishEvents[1].exactOutput).toBe(false);
      expect(finishEvents[1].outputTokens).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("enables include_usage and taps SSE reasoning_content on custom OpenAI-compatible gateways", async () => {
    const prevOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-openai-key";
    const originalFetch = globalThis.fetch;
    let wireBody: Record<string, unknown> = {};
    const progressEvents: LlmCallProgressEvent[] = [];

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      wireBody = JSON.parse(String(init?.body ?? "{}"));
      const ssePayload = [
        `data: ${JSON.stringify({
          id: "chatcmpl-oai-1",
          object: "chat.completion.chunk",
          created: 1700000000,
          model: "deepseek/deepseek-v4.1-flash",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", reasoning_content: "Thinking about register x1..." },
              finish_reason: null,
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "chatcmpl-oai-1",
          object: "chat.completion.chunk",
          created: 1700000000,
          model: "deepseek/deepseek-v4.1-flash",
          choices: [
            {
              index: 0,
              delta: { content: `<translation id="${UNIT_B}">\n使用 \`x1\`。\n</translation>` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 240, completion_tokens: 45, total_tokens: 285 },
        })}\n\n`,
        "data: [DONE]\n\n",
      ].join("");
      return new Response(ssePayload, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const out = await translateChapterBatch({
        glossaryMarkdown: "- `x1` -> `x1`",
        chapterTitle: "Chapter 1",
        chapterBlocks: [{ unit_id: UNIT_B, kind: "paragraph", en: "Use `x1`." }],
        targets: [{ unit_id: UNIT_B, en: "Use `x1`.", kind: "paragraph" }],
        provider: "openai",
        model: "deepseek/deepseek-v4.1-flash",
        baseUrl: "https://gateway.example.test/v1",
        onLlmProgress: (event) => progressEvents.push(event),
      });

      expect(out.get(UNIT_B)).toEqual({ zh: "使用 `x1`。", status: "machine" });
      expect(wireBody.stream).toBe(true);
      expect(wireBody.stream_options).toEqual({ include_usage: true });

      const phases = progressEvents.map((e) => e.phase);
      expect(phases[0]).toBe("uploading");
      expect(phases[1]).toBe("waiting");
      // 2 stream events: 1 from reasoning_content tap + 1 from content delta
      const streamEvents = progressEvents.filter((e) => e.phase === "stream");
      expect(streamEvents.length).toBeGreaterThanOrEqual(2);
      expect(streamEvents[0].outputTokens).toBeGreaterThan(0);

      const finish = progressEvents[progressEvents.length - 1];
      expect(finish.phase).toBe("finish");
      expect(finish.exactInput).toBe(true);
      expect(finish.inputTokens).toBe(240);
      expect(finish.exactOutput).toBe(true);
      expect(finish.outputTokens).toBe(45);
    } finally {
      globalThis.fetch = originalFetch;
      if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpenAiKey;
    }
  });

  it("places <change_history> with <diff> and <previous_translation> immediately before <unit>", async () => {
    let capturedPrompt = "";
    let capturedSystem = "";

    setGenerateObjectForTest(async (opts) => {
      capturedSystem = opts.system;
      capturedPrompt = opts.messages[0].content;
      return {
        object: {
          translations: [{ unit_id: UNIT_B, zh: "将 12 与 `x1` 相加。" }],
        },
      };
    });

    const out = await translateChapterBatch({
      glossaryMarkdown: "- `x1` -> `x1`",
      chapterTitle: "Chapter 1",
      chapterBlocks: [{ unit_id: UNIT_B, kind: "paragraph", en: "Add 12 and `x1`." }],
      targets: [
        {
          unit_id: UNIT_B,
          en: "Add 12 and `x1`.",
          kind: "paragraph",
          prev_en: "Add 8 and `x1`.",
          prev_zh: "将 8 与 `x1` 相加。",
        },
      ],
      provider: "google",
    });

    expect(capturedSystem).toContain('<change_history unit_id="...">');
    expect(capturedPrompt).toContain(
      [
        `<change_history unit_id="${UNIT_B}">`,
        "<diff>",
        "Add [-8-]{+12+} and `x1`.",
        "</diff>",
        "<previous_translation>",
        "将 8 与 `x1` 相加。",
        "</previous_translation>",
        "</change_history>",
        `<unit id="${UNIT_B}" kind="paragraph">`,
        "Add 12 and `x1`.",
        "</unit>",
      ].join("\n"),
    );
    expect(out.get(UNIT_B)).toEqual({
      zh: "将 12 与 `x1` 相加。",
      status: "machine",
    });
  });

  it("uses default provider and its default model when provider and model are omitted", async () => {
    delete process.env.AI_PROVIDER;
    delete process.env.AI_MODEL;
    expect(resolveProvider()).toBe("openai");

    process.env.AI_PROVIDER = "";
    expect(resolveProvider()).toBe("openai");
    const expectedModel = defaultModelForProvider("openai");
    expect(expectedModel.length).toBeGreaterThan(0);

    process.env.OPENAI_API_KEY = "test-openai-key";
    let capturedModelId = "";

    setGenerateObjectForTest((async (opts: { model: { modelId: string } }) => {
      capturedModelId = opts.model.modelId;
      return {
        object: {
          translations: [{ unit_id: UNIT_B, zh: "使用 `x1` 和掩码 0x1f。" }],
        },
      } as never;
    }) as never);

    const out = await translateChapterBatch({
      glossaryMarkdown: "- `x1` -> `x1`",
      chapterTitle: "Chapter 1",
      chapterBlocks: [{ unit_id: UNIT_B, en: "Use `x1` and mask 0x1f." }],
      targets: [{ unit_id: UNIT_B, en: "Use `x1` and mask 0x1f.", kind: "paragraph" }],
    });

    expect(capturedModelId).toBe(expectedModel);
    expect(out.get(UNIT_B)).toEqual({
      zh: "使用 `x1` 和掩码 0x1f。",
      status: "machine",
    });
  });

  it("formats APICallError with provider, model, baseUrl, statusCode, url, and response body", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    const apiErr = new APICallError({
      message: "Not Found",
      url: "https://override.example.test/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseBody: '{"error":{"message":"model not found"}}',
    });

    setGenerateObjectForTest((async () => {
      throw apiErr;
    }) as never);

    let caught: unknown;
    try {
      await translateChapterBatch({
        glossaryMarkdown: "- `x1` -> `x1`",
        chapterTitle: "Chapter 1",
        chapterBlocks: [{ unit_id: UNIT_B, en: "Use `x1`." }],
        targets: [{ unit_id: UNIT_B, en: "Use `x1`.", kind: "paragraph" }],
        provider: "deepseek",
        model: "deepseek-chat",
        baseUrl: "https://override.example.test/v1",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error;
    expect(err.message).toContain("LLM call failed");
    expect(err.message).toContain("deepseek/deepseek-chat");
    expect(err.message).toContain("baseUrl=https://override.example.test/v1");
    expect(err.message).toContain("attempt 1/3");
    expect(err.message).toContain('chapter "Chapter 1"');
    expect(err.message).toContain("HTTP 404 Not Found");
    expect(err.message).toContain("url: https://override.example.test/v1/chat/completions");
    expect(err.message).toContain('response: {"error":{"message":"model not found"}}');
    expect(err.cause).toBe(apiErr);
  });

  it("unwraps RetryError and NoObjectGeneratedError details", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    const inner = new APICallError({
      message: "Too Many Requests",
      url: "https://api.deepseek.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 429,
    });
    const retryErr = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [inner],
    });

    setGenerateObjectForTest((async () => {
      throw retryErr;
    }) as never);

    await expect(
      translateChapterBatch({
        glossaryMarkdown: "",
        chapterTitle: "Chapter 2",
        chapterBlocks: [{ unit_id: UNIT_B, en: "Hello" }],
        targets: [{ unit_id: UNIT_B, en: "Hello", kind: "paragraph" }],
        provider: "deepseek",
        model: "test-model",
      }),
    ).rejects.toThrow(/LLM call failed \(deepseek\/test-model, attempt 1\/3, chapter "Chapter 2"\): Failed after 3 attempts \(last error: HTTP 429 Too Many Requests/);

    const noObjErr = new NoObjectGeneratedError({
      message: "No object generated",
      cause: new Error("Invalid JSON"),
      text: "{bad json",
      response: { id: "1", timestamp: new Date(), modelId: "test-model" },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    setGenerateObjectForTest((async () => {
      throw noObjErr;
    }) as never);

    await expect(
      translateChapterBatch({
        glossaryMarkdown: "",
        chapterTitle: "Chapter 2",
        chapterBlocks: [{ unit_id: UNIT_B, en: "Hello" }],
        targets: [{ unit_id: UNIT_B, en: "Hello", kind: "paragraph" }],
        provider: "deepseek",
        model: "test-model",
      }),
    ).rejects.toThrow(/LLM call failed.*No object generated \| cause: Invalid JSON \| raw: \{bad json/);
  });

  it("uploads batch traces (chain + llm runs) to LangSmith when enabled", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGSMITH_API_KEY = "lsv2-test-key";
    process.env.LANGSMITH_PROJECT = "riscv-manual-debug";
    process.env.LANGSMITH_ENDPOINT = "https://langsmith.example.test/";

    const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const decodeBody = (body: RequestInit["body"]) =>
      body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body ?? "{}");
    setLangSmithFetchForTest((async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(decodeBody(init?.body)),
      });
      return new Response("{}", { status: 202 });
    }) as never);

    let calls = 0;
    setGenerateObjectForTest((async () => {
      calls++;
      if (calls === 1) {
        return {
          object: { translations: [{ unit_id: UNIT_B, zh: "缺少反引号。" }] },
          finishReason: "stop",
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        } as never;
      }
      return {
        object: { translations: [{ unit_id: UNIT_B, zh: "使用 `x1`。" }] },
        finishReason: "stop",
        usage: { promptTokens: 130, completionTokens: 25, totalTokens: 155 },
      } as never;
    }) as never);

    const out = await translateChapterBatch({
      glossaryMarkdown: "- `x1` -> `x1`",
      chapterTitle: "Chapter 1",
      chapterBlocks: [{ unit_id: UNIT_B, en: "Use `x1`." }],
      targets: [{ unit_id: UNIT_B, en: "Use `x1`.", kind: "paragraph" }],
      provider: "deepseek",
    });

    expect(out.get(UNIT_B)?.zh).toBe("使用 `x1`。");
    expect(requests).toHaveLength(3); // 1 chain + 2 llm attempts
    expect(requests[0].url).toBe("https://langsmith.example.test/runs");
    expect(requests[0].headers["x-api-key"]).toBe("lsv2-test-key");

    const [chainRun, llm1, llm2] = requests.map((r) => r.body as Record<string, unknown>);
    expect(chainRun.run_type).toBe("chain");
    expect(chainRun.name).toBe("translateChapterBatch");
    expect(chainRun.session_name).toBe("riscv-manual-debug");
    expect(chainRun.outputs).toEqual({ translatedCount: 1, unitIds: [UNIT_B] });

    expect(llm1.run_type).toBe("llm");
    expect(llm1.parent_run_id).toBe(chainRun.id);
    expect(llm1.trace_id).toBe(chainRun.trace_id);
    expect((llm1.dotted_order as string).startsWith(`${chainRun.dotted_order as string}.`)).toBe(true);
    const llm1Outputs = llm1.outputs as Record<string, unknown>;
    expect(llm1Outputs.object).toBeUndefined();
    expect(llm1Outputs.choices).toEqual([
      {
        index: 0,
        message: {
          role: "assistant",
          content: `<translation id="${UNIT_B}">\n缺少反引号。\n</translation>`,
        },
        finish_reason: "stop",
      },
    ]);
    expect(llm1Outputs.llm_output).toEqual({
      token_usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });

    expect(llm2.run_type).toBe("llm");
    expect(llm2.parent_run_id).toBe(chainRun.id);
  });

  it("uploads error trace on LLM failure and never breaks translation if LangSmith fails", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.LANGCHAIN_TRACING_V2 = "true";
    process.env.LANGCHAIN_API_KEY = "lsv2-legacy-key";

    const capturedRuns: Array<Record<string, unknown>> = [];
    setLangSmithFetchForTest((async (_url: string | URL | Request, init?: RequestInit) => {
      const raw =
        init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init?.body ?? "{}");
      capturedRuns.push(JSON.parse(raw) as Record<string, unknown>);
      return new Response("Bad Request", { status: 400 });
    }) as never);

    setGenerateObjectForTest((async () => {
      throw new APICallError({
        message: "Bad Gateway",
        url: "https://api.deepseek.com/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 502,
      });
    }) as never);

    await expect(
      translateChapterBatch({
        glossaryMarkdown: "",
        chapterTitle: "Chapter 3",
        chapterBlocks: [{ unit_id: UNIT_B, en: "Hello" }],
        targets: [{ unit_id: UNIT_B, en: "Hello", kind: "paragraph" }],
        provider: "deepseek",
      }),
    ).rejects.toThrow(/HTTP 502 Bad Gateway/);

    expect(capturedRuns.length).toBeGreaterThanOrEqual(1);
    expect(capturedRuns[0].error).toContain("HTTP 502 Bad Gateway");

    delete process.env.LANGCHAIN_TRACING_V2;
    delete process.env.LANGCHAIN_API_KEY;
    expect(resolveLangSmithConfig({ LANGSMITH_TRACING: "true" })).toBeNull();
  });

  it("supports LANGSMITH_AGENT_ID and LANGSMITH_AGENT_ENVIRONMENT addressing", async () => {
    expect(
      resolveLangSmithConfig({
        LANGSMITH_TRACING: "true",
        LANGSMITH_API_KEY: "lsv2-key",
        LANGSMITH_AGENT_ENVIRONMENT: "local",
      }),
    ).toEqual({
      apiKey: "lsv2-key",
      endpoint: "https://api.smith.langchain.com",
      project: "default",
      agentEnvironment: "local",
    });

    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGSMITH_API_KEY = "lsv2-agent-key";
    process.env.LANGSMITH_ENDPOINT = "https://langsmith.example.test";
    process.env.LANGSMITH_AGENT_ID = "riscv-translator";
    process.env.LANGSMITH_AGENT_ENVIRONMENT = "local";

    const runs: Array<Record<string, unknown>> = [];
    setLangSmithFetchForTest((async (_url: string | URL | Request, init?: RequestInit) => {
      const raw =
        init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init?.body ?? "{}");
      runs.push(JSON.parse(raw) as Record<string, unknown>);
      return new Response("{}", { status: 202 });
    }) as never);

    setGenerateObjectForTest((async () => ({
      object: { translations: [{ unit_id: UNIT_B, zh: "使用 `x1`。" }] },
      finishReason: "stop",
    })) as never);

    await translateChapterBatch({
      glossaryMarkdown: "",
      chapterTitle: "Chapter 1",
      chapterBlocks: [{ unit_id: UNIT_B, en: "Use `x1`." }],
      targets: [{ unit_id: UNIT_B, en: "Use `x1`.", kind: "paragraph" }],
      provider: "deepseek",
    });

    expect(runs).toHaveLength(2);
    expect(runs[0].session_name).toBeUndefined();
    expect(runs[0].address).toBe("lrn:agents/riscv-translator/environments/local");

    delete process.env.LANGSMITH_AGENT_ID;
    delete process.env.LANGSMITH_AGENT_ENVIRONMENT;
  });

  it("splits oversized output across passes while keeping identical chapter prefix for KV cache and supports onPassComplete stop", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    const UNIT_C = "cccccccccccccccccccccccccccccccc";
    const UNIT_D = "dddddddddddddddddddddddddddddddd";

    const longSentence =
      "Vector arithmetic instruction adds elements across vector registers with masking support. ".repeat(5);
    const chapterBlocks = [
      { unit_id: UNIT_A, kind: "heading" as const, en: "== Vector Extension", zh: "== 向量扩展", status: "approved" as const },
      { unit_id: UNIT_B, kind: "paragraph" as const, en: `First unit: ${longSentence}` },
      { unit_id: UNIT_C, kind: "paragraph" as const, en: `Second unit: ${longSentence}` },
      { unit_id: UNIT_D, kind: "paragraph" as const, en: `Third unit: ${longSentence}` },
    ];
    const targets = [
      { unit_id: UNIT_B, kind: "paragraph" as const, en: chapterBlocks[1].en },
      { unit_id: UNIT_C, kind: "paragraph" as const, en: chapterBlocks[2].en },
      { unit_id: UNIT_D, kind: "paragraph" as const, en: chapterBlocks[3].en },
    ];

    const calls: Array<{ system: string; user: string }> = [];
    setGenerateObjectForTest(async (opts) => {
      const user = opts.messages[0].content;
      calls.push({ system: opts.system, user });
      const match = /<target_ids>\n([\s\S]*?)\n<\/target_ids>/.exec(user);
      const ids = match ? match[1].trim().split("\n") : [];
      return {
        object: {
          translations: ids.map((id) => ({ unit_id: id, zh: `译文 ${id.slice(0, 4)}。` })),
        },
        finishReason: "stop",
      };
    });

    const passCallbacks: Array<{ index: number; totalPasses: number; keys: string[] }> = [];
    const out = await translateChapterBatch({
      glossaryMarkdown: "- `vector` -> 向量",
      chapterTitle: "Vector Extension",
      chapterBlocks,
      targets,
      provider: "deepseek",
      maxOutputTokens: 250, // forces 3 passes (1 target per pass)
      onPassComplete: (passResults, info) => {
        passCallbacks.push({
          index: info.passIndex,
          totalPasses: info.totalPasses,
          keys: [...passResults.keys()],
        });
      },
    });

    expect(calls).toHaveLength(3);
    expect(out.size).toBe(3);
    expect(passCallbacks).toEqual([
      { index: 0, totalPasses: 3, keys: [UNIT_B] },
      { index: 1, totalPasses: 3, keys: [UNIT_C] },
      { index: 2, totalPasses: 3, keys: [UNIT_D] },
    ]);

    // System prompt and everything before `<target_ids>` must be byte-for-byte identical across all 3 passes
    const prefix0 = calls[0].user.slice(0, calls[0].user.indexOf("Translate ONLY the following <unit> IDs"));
    const prefix1 = calls[1].user.slice(0, calls[1].user.indexOf("Translate ONLY the following <unit> IDs"));
    const prefix2 = calls[2].user.slice(0, calls[2].user.indexOf("Translate ONLY the following <unit> IDs"));
    expect(calls[1].system).toBe(calls[0].system);
    expect(calls[2].system).toBe(calls[0].system);
    expect(calls[0].system).toContain("When <target_ids> is present");
    expect(prefix1).toBe(prefix0);
    expect(prefix2).toBe(prefix0);

    // Verify returning false from onPassComplete halts before running subsequent passes
    let haltedCalls = 0;
    setGenerateObjectForTest(async (opts) => {
      haltedCalls++;
      const user = opts.messages[0].content;
      const match = /<target_ids>\n([\s\S]*?)\n<\/target_ids>/.exec(user);
      const ids = match ? match[1].trim().split("\n") : [];
      return {
        object: {
          translations: ids.map((id) => ({ unit_id: id, zh: `部分 ${id.slice(0, 4)}。` })),
        },
        finishReason: "stop",
      };
    });

    const partial = await translateChapterBatch({
      glossaryMarkdown: "- `vector` -> 向量",
      chapterTitle: "Vector Extension",
      chapterBlocks,
      targets,
      provider: "deepseek",
      maxOutputTokens: 250,
      onPassComplete: (_passResults, info) => info.passIndex === 0 ? false : true,
    });
    expect(haltedCalls).toBe(1);
    expect([...partial.keys()]).toEqual([UNIT_B]);
  });

  it("enforces maxInputTokens across Tier 2 (EN-only context) and Tier 3 (windowed context)", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";

    // Tier 2: bilingual context exceeds maxInputTokens, EN-only context fits -> keeps all EN, drops context zh
    const ctxEn = "This reference paragraph explains memory ordering constraints. ".repeat(10).trim();
    const ctxZh = "该参考段落说明了内存序约束及相关硬件线程规则。".repeat(8);
    const tier2Blocks = [
      { unit_id: "11111111111111111111111111111111", kind: "paragraph" as const, en: `${ctxEn} [C1]`, zh: `${ctxZh} [ZH1]`, status: "approved" as const },
      { unit_id: "22222222222222222222222222222222", kind: "paragraph" as const, en: `${ctxEn} [C2]`, zh: `${ctxZh} [ZH2]`, status: "approved" as const },
      { unit_id: "33333333333333333333333333333333", kind: "paragraph" as const, en: `${ctxEn} [C3]`, zh: `${ctxZh} [ZH3]`, status: "approved" as const },
      { unit_id: "44444444444444444444444444444444", kind: "paragraph" as const, en: `${ctxEn} [C4]`, zh: `${ctxZh} [ZH4]`, status: "approved" as const },
      { unit_id: UNIT_B, kind: "paragraph" as const, en: "Translate `x1` cleanly." },
    ];

    let tier2User = "";
    setGenerateObjectForTest(async (opts) => {
      tier2User = opts.messages[0].content;
      return {
        object: { translations: [{ unit_id: UNIT_B, zh: "清晰翻译 `x1`。" }] },
        finishReason: "stop",
      };
    });

    await translateChapterBatch({
      glossaryMarkdown: "- `x1` -> `x1`",
      chapterTitle: "Memory Model",
      chapterBlocks: tier2Blocks,
      targets: [{ unit_id: UNIT_B, en: "Translate `x1` cleanly.", kind: "paragraph" }],
      provider: "deepseek",
      maxInputTokens: 1650,
    });
    expect(tier2User).toContain("[C1]");
    expect(tier2User).toContain("[C4]");
    expect(tier2User).not.toContain("[ZH1]");
    expect(tier2User).not.toContain("[ZH4]");

    // Tier 3: even EN-only full chapter exceeds maxInputTokens -> windows local context around each pass
    const filler = "Hardware thread executes instruction sequence without stalls. ".repeat(9).trim();
    const t1Id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01";
    const t2Id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02";
    const tier3Blocks = [
      { unit_id: "00000000000000000000000000000000", kind: "heading" as const, en: "== Giant Chapter", zh: "== 巨型章节", status: "approved" as const },
      { unit_id: "00000000000000000000000000000001", kind: "paragraph" as const, en: `[FAR-START-1] ${filler}` },
      { unit_id: "00000000000000000000000000000002", kind: "paragraph" as const, en: `[FAR-START-2] ${filler}` },
      { unit_id: "00000000000000000000000000000003", kind: "paragraph" as const, en: `[FAR-START-3] ${filler}` },
      { unit_id: "00000000000000000000000000000004", kind: "paragraph" as const, en: `[NEAR-T1-PREV] Short note.` },
      { unit_id: t1Id, kind: "paragraph" as const, en: `[TARGET-1] ${filler}` },
      { unit_id: "00000000000000000000000000000006", kind: "paragraph" as const, en: `[MID-1] ${filler}` },
      { unit_id: "00000000000000000000000000000007", kind: "paragraph" as const, en: `[MID-2] ${filler}` },
      { unit_id: "00000000000000000000000000000008", kind: "paragraph" as const, en: `[MID-3] ${filler}` },
      { unit_id: "00000000000000000000000000000009", kind: "paragraph" as const, en: `[NEAR-T2-PREV] Short note.` },
      { unit_id: t2Id, kind: "paragraph" as const, en: `[TARGET-2] ${filler}` },
    ];

    const tier3Prompts: string[] = [];
    setGenerateObjectForTest(async (opts) => {
      const user = opts.messages[0].content;
      tier3Prompts.push(user);
      const ids = [...user.matchAll(/<unit id="([0-9a-f]{32})"/g)].map((m) => m[1]);
      return {
        object: { translations: ids.map((id) => ({ unit_id: id, zh: `窗口译文 ${id.slice(-2)}。` })) },
        finishReason: "stop",
      };
    });

    const tier3Out = await translateChapterBatch({
      glossaryMarkdown: "- `x1` -> `x1`",
      chapterTitle: "Giant Chapter",
      chapterBlocks: tier3Blocks,
      targets: [
        { unit_id: t1Id, kind: "paragraph", en: tier3Blocks[5].en },
        { unit_id: t2Id, kind: "paragraph", en: tier3Blocks[10].en },
      ],
      provider: "deepseek",
      maxInputTokens: 1100,
      maxOutputTokens: 10_000,
    });

    expect(tier3Out.size).toBe(2);
    expect(tier3Prompts).toHaveLength(2);
    expect(tier3Prompts[0]).toContain("== Giant Chapter");
    expect(tier3Prompts[0]).toContain("[NEAR-T1-PREV]");
    expect(tier3Prompts[0]).not.toContain("[FAR-START-1]");
    expect(tier3Prompts[1]).toContain("[NEAR-T2-PREV]");
    expect(tier3Prompts[1]).not.toContain("[FAR-START-1]");
    for (const p of tier3Prompts) {
      expect(estimateTokens(p)).toBeLessThan(650);
    }
  });

  it("salvages completed items from truncated <translation> output and continues remaining units", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";

    const truncated = [
      "```xml",
      `<translation id="${UNIT_A}">`,
      '已完整"保存"的单元 {1}，含 stem:[\\text{VLEN} \\ge \\frac{a}{b}]。',
      "</translation>",
      `<translation id="${UNIT_B}">`,
      "这个单元在输出中途被截",
    ].join("\n");
    expect(salvageTruncatedTranslations(truncated)).toEqual([
      { unit_id: UNIT_A, zh: '已完整"保存"的单元 {1}，含 stem:[\\text{VLEN} \\ge \\frac{a}{b}]。' },
    ]);
    expect(
      parseUnitFenceTranslations(
        `<translation id="${UNIT_A}">\n忘关标签\n<translation id="${UNIT_B}">\n完整单元 \`x1\`。\n</translation>`,
      ),
    ).toEqual([{ unit_id: UNIT_B, zh: "完整单元 `x1`。" }]);
    expect(
      parseUnitFenceTranslations(`<unit id="${UNIT_B}">\n兼容回退 \`x1\`。\n</unit>`),
    ).toEqual([{ unit_id: UNIT_B, zh: "兼容回退 `x1`。" }]);

    let callCount = 0;
    const seenPrompts: string[] = [];
    setGenerateObjectForTest(async (opts) => {
      callCount++;
      seenPrompts.push(opts.messages[opts.messages.length - 1].content);
      if (callCount === 1) {
        return {
          text: `<translation id="${UNIT_A}">\n章节一 \`x0\`。\n</translation>\n<translation id="${UNIT_B}">\n被截断`,
          finishReason: "length",
          usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
          response: { id: "resp-1", modelId: "deepseek-chat" },
        };
      }
      return {
        text: `<translation id="${UNIT_B}">\n续传完成 \`x1\`。\n</translation>`,
        finishReason: "stop",
      };
    });

    const out = await translateChapterBatch({
      glossaryMarkdown: "- `x0` -> `x0`",
      chapterTitle: "Chapter 1",
      chapterBlocks: [
        { unit_id: UNIT_A, kind: "paragraph", en: "Keep `x0`." },
        { unit_id: UNIT_B, kind: "paragraph", en: "Keep `x1`." },
      ],
      targets: [
        { unit_id: UNIT_A, kind: "paragraph", en: "Keep `x0`." },
        { unit_id: UNIT_B, kind: "paragraph", en: "Keep `x1`." },
      ],
      provider: "deepseek",
    });

    expect(callCount).toBe(2);
    expect(out.get(UNIT_A)?.zh).toBe("章节一 `x0`。");
    expect(out.get(UNIT_B)?.zh).toBe("续传完成 `x1`。");
    // Continuation re-uses shared prompt prefix and requests only the missing unit ID
    expect(seenPrompts[1]).toContain("<target_ids>");
    expect(seenPrompts[1]).toContain(UNIT_B);
    expect(seenPrompts[1].slice(seenPrompts[1].indexOf("<target_ids>"))).not.toContain(UNIT_A);
  });

  it("flushes already-validated units via onPassComplete when another unit in the pass fails retries", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";

    setGenerateObjectForTest(async () => ({
      object: {
        translations: [
          { unit_id: UNIT_A, zh: "保留 `x0`。" },
          { unit_id: UNIT_B, zh: "缺少反引号。" },
        ],
      },
      finishReason: "stop",
    }));

    const flushed: Array<Array<[string, string]>> = [];
    await expect(
      translateChapterBatch({
        glossaryMarkdown: "- `x0` -> `x0`",
        chapterTitle: "Partial Flush Chapter",
        chapterBlocks: [
          { unit_id: UNIT_A, kind: "paragraph", en: "Keep `x0`." },
          { unit_id: UNIT_B, kind: "paragraph", en: "Keep `x1`." },
        ],
        targets: [
          { unit_id: UNIT_A, kind: "paragraph", en: "Keep `x0`." },
          { unit_id: UNIT_B, kind: "paragraph", en: "Keep `x1`." },
        ],
        provider: "deepseek",
        onPassComplete: (passResults) => {
          flushed.push([...passResults.entries()].map(([id, v]) => [id, v.zh]));
        },
      }),
    ).rejects.toThrow("Translation validation failed after 2 retries");

    expect(flushed).toEqual([[[UNIT_A, "保留 `x0`。"]]]);
  });

  it("maps reasoningEffort to provider wire payloads and temperature settings across providers", async () => {
    const validResponseText = `<translation id="${UNIT_A}">保留 \`x0\`。</translation>`;
    const makeSseResponse = (events: string[]): Response =>
      new Response(events.join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const openAiSse = () =>
      makeSseResponse([
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ index: 0, delta: { role: "assistant", content: validResponseText }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 8 },
        })}\n\n`,
        "data: [DONE]\n\n",
      ]);

    const googleSse = () =>
      makeSseResponse([
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: validResponseText }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8 },
        })}\n\n`,
      ]);

    const anthropicSse = () =>
      makeSseResponse([
        `data: ${JSON.stringify({
          type: "message_start",
          message: { id: "msg_test", model: "claude", usage: { input_tokens: 10, output_tokens: 0 } },
        })}\n\n`,
        `data: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })}\n\n`,
        `data: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: validResponseText },
        })}\n\n`,
        `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `data: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 8 },
        })}\n\n`,
        `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ]);

    const origFetch = globalThis.fetch;
    const prevEnv: Record<string, string | undefined> = {
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    const capturedBodies: Array<{ url: string; body: Record<string, unknown> }> = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const rawBody =
        typeof init?.body === "string"
          ? init.body
          : init?.body instanceof Uint8Array
            ? new TextDecoder().decode(init.body)
            : "{}";
      capturedBodies.push({ url, body: JSON.parse(rawBody) as Record<string, unknown> });

      if (url.includes("generativelanguage.googleapis.com")) {
        return googleSse();
      }
      if (url.includes("anthropic.com")) {
        return anthropicSse();
      }
      return openAiSse();
    }) as typeof fetch;

    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-google-key";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

    const makeBaseCall = () => ({
      glossaryMarkdown: "- `x0` -> `x0`",
      chapterTitle: "Reasoning Effort Test",
      chapterBlocks: [{ unit_id: UNIT_A, kind: "paragraph" as const, en: "Keep `x0`." }],
      targets: [{ unit_id: UNIT_A, kind: "paragraph" as const, en: "Keep `x0`." }],
    });

    try {
      await translateChapterBatch({ ...makeBaseCall(), provider: "deepseek", reasoningEffort: "low" });
      await translateChapterBatch({ ...makeBaseCall(), provider: "openai", reasoningEffort: "high" });
      await translateChapterBatch({ ...makeBaseCall(), provider: "openai", reasoningEffort: "none" });
      await translateChapterBatch({ ...makeBaseCall(), provider: "google", reasoningEffort: "medium" });
      await translateChapterBatch({ ...makeBaseCall(), provider: "google", reasoningEffort: "none" });
      await translateChapterBatch({ ...makeBaseCall(), provider: "anthropic", reasoningEffort: "high" });
      await translateChapterBatch({ ...makeBaseCall(), provider: "anthropic", reasoningEffort: "none" });
    } finally {
      globalThis.fetch = origFetch;
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    expect(capturedBodies).toHaveLength(7);

    // deepseek low: snake_case reasoning_effort without temperature
    expect(capturedBodies[0]!.url).toContain("deepseek");
    expect(capturedBodies[0]!.body.reasoning_effort).toBe("low");
    expect(capturedBodies[0]!.body.temperature).toBeUndefined();

    // openai high vs none
    expect(capturedBodies[1]!.url).toContain("openai.com");
    expect(capturedBodies[1]!.body.reasoning_effort).toBe("high");
    expect(capturedBodies[1]!.body.temperature).toBeUndefined();
    expect(capturedBodies[2]!.body.reasoning_effort).toBe("none");
    expect(capturedBodies[2]!.body.temperature).toBe(0);

    // google medium vs none
    expect(capturedBodies[3]!.url).toContain("generativelanguage.googleapis.com");
    expect((capturedBodies[3]!.body.generationConfig as Record<string, unknown>)?.thinkingConfig).toEqual({
      thinkingBudget: 8192,
    });
    expect((capturedBodies[4]!.body.generationConfig as Record<string, unknown>)?.thinkingConfig).toEqual({
      thinkingBudget: 0,
    });

    // anthropic high vs none
    expect(capturedBodies[5]!.url).toContain("anthropic.com");
    expect(capturedBodies[5]!.body.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
    expect(capturedBodies[5]!.body.temperature).toBeUndefined();
    expect(capturedBodies[6]!.body.thinking).toBeUndefined();
    expect(capturedBodies[6]!.body.temperature).toBe(0);
  });

  it("rejects invalid reasoningEffort even with mock provider", async () => {
    await expect(
      translateChapterBatch({
        glossaryMarkdown: "- `x0` -> `x0`",
        chapterTitle: "Invalid Reasoning",
        chapterBlocks: [{ unit_id: UNIT_A, kind: "paragraph", en: "Keep `x0`." }],
        targets: [{ unit_id: UNIT_A, kind: "paragraph", en: "Keep `x0`." }],
        provider: "mock",
        reasoningEffort: "invalid",
      }),
    ).rejects.toThrow("Invalid AI_REASONING_EFFORT value");
  });
});
