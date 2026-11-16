import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { BlockKind, TranslationStatus } from "@riscv-cn/schema";
import {
  AISDKError,
  APICallError,
  LoadAPIKeyError,
  NoObjectGeneratedError,
  RetryError,
  streamText,
  type LanguageModel,
} from "ai";
import { diffWords } from "diff";
import {
  DEFAULT_AI_MAX_INPUT_TOKENS,
  DEFAULT_AI_MAX_OUTPUT_TOKENS,
  REASONING_EFFORT_VALUES,
  type ReasoningEffort,
} from "../env-keys.ts";
import { isVerbose, vlog } from "../log.ts";
import { extractRiscvMacroTokens, stripHeadingMarkers } from "../parser/index.ts";
import { LangSmithBatchTrace, resolveLangSmithConfig } from "./langsmith.ts";

export { REASONING_EFFORT_VALUES, type ReasoningEffort } from "../env-keys.ts";
export const DEFAULT_MAX_INPUT_TOKENS = DEFAULT_AI_MAX_INPUT_TOKENS;
export const DEFAULT_MAX_OUTPUT_TOKENS = DEFAULT_AI_MAX_OUTPUT_TOKENS;

export type SupportedProvider = "deepseek" | "google" | "openai" | "anthropic" | "mock";

export interface ChapterContextBlock {
  unit_id: string;
  kind?: BlockKind;
  en: string;
  zh?: string;
  status?: TranslationStatus;
}

export interface TranslationTarget {
  unit_id: string;
  en: string;
  kind: BlockKind;
  prev_en?: string;
  prev_zh?: string;
}

export interface LlmCallProgressEvent {
  phase: "uploading" | "waiting" | "stream" | "finish";
  /** Prompt / input tokens sent in this LLM call (locally estimated until `exactInput` is true). */
  inputTokens: number;
  /** True when `inputTokens` came from provider-reported `usage.promptTokens`. */
  exactInput: boolean;
  /** Output tokens received in this LLM call (locally estimated until `exactOutput` is true). */
  outputTokens: number;
  /** True when `outputTokens` came from provider-reported `usage.completionTokens`. */
  exactOutput: boolean;
  /** Generation rate in output tokens per second, when measurable. */
  tokPerSec?: number;
  /** Measured generation duration in ms (used for multi-batch summary rate). */
  genMs?: number;
  /** 0-based pass index within the chapter batch. */
  passIndex: number;
  /** Total passes planned for the chapter batch. */
  totalPasses: number;
  /** 1-based validation attempt index. */
  attempt: number;
}

export interface TranslateChapterBatchOptions {
  glossaryMarkdown: string;
  chapterTitle: string;
  chapterBlocks: ChapterContextBlock[];
  targets: TranslationTarget[];
  provider?: string;
  model?: string;
  baseUrl?: string;
  reasoningEffort?: ReasoningEffort | string;
  abortSignal?: AbortSignal;
  /** Soft input token cap used only as guidance for context windowing / pass splitting (never enforced in the AI API). */
  maxInputTokens?: number;
  /** Soft output token cap used only as guidance for multi-pass target splitting (never sent as `maxTokens` to the AI API). */
  maxOutputTokens?: number;
  onLlmProgress?: (event: LlmCallProgressEvent) => void;
  onPassComplete?: (
    passResults: ReadonlyMap<string, { zh: string; status: TranslationStatus }>,
    info: { passIndex: number; totalPasses: number },
  ) => boolean | void;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface ParsedUnitTranslation {
  unit_id: string;
  zh: string;
}

export interface TranslationChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateTranslationCallOptions {
  model: LanguageModel;
  system: string;
  messages: TranslationChatMessage[];
  prompt: string;
  reasoningEffort?: ReasoningEffort;
  providerOptions?: Record<string, Record<string, unknown>>;
  abortSignal?: AbortSignal;
  onHeadersReceived?: () => void;
  onStreamChunk?: (deltaText: string, estimatedCallTokens: number, tokPerSec?: number) => void;
}

export interface GenerateTranslationCallResult {
  object?: {
    translations: ParsedUnitTranslation[];
  };
  text?: string;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  response?: {
    id?: string;
    modelId?: string;
  };
}

export type GenerateTranslationFn = (
  options: GenerateTranslationCallOptions,
) => Promise<GenerateTranslationCallResult>;

let activeGenerateOverride: GenerateTranslationFn | undefined;

/**
 * Test hook to override the underlying LLM translation call in unit tests.
 */
export function setGenerateObjectForTest(fn?: GenerateTranslationFn): void {
  activeGenerateOverride = fn;
}

export function formatUnitFenceTranslations(
  translations: ReadonlyArray<ParsedUnitTranslation>,
): string {
  return translations
    .map((item) => `<translation id="${item.unit_id}">\n${item.zh}\n</translation>`)
    .join("\n\n");
}

function parseUnitFenceResult(rawText: string): {
  translations: ParsedUnitTranslation[];
  hasTrailingUnclosedUnit: boolean;
} {
  const openRe = /<(translation|unit)\s+[^>]*?(?:unit_)?id\s*=\s*["']([^"'\s>]+)["'][^>]*>/gi;
  const opens: Array<{ tag: string; id: string; tagStart: number; bodyStart: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = openRe.exec(rawText)) !== null) {
    opens.push({
      tag: match[1].toLowerCase(),
      id: match[2],
      tagStart: match.index,
      bodyStart: match.index + match[0].length,
    });
  }

  const translations: ParsedUnitTranslation[] = [];
  let hasTrailingUnclosedUnit = false;

  for (let i = 0; i < opens.length; i++) {
    const cur = opens[i];
    const nextOpenStart = i + 1 < opens.length ? opens[i + 1].tagStart : rawText.length;
    const closeRe = new RegExp(`</${cur.tag}\\s*>`, "gi");
    closeRe.lastIndex = cur.bodyStart;
    const closeMatch = closeRe.exec(rawText);
    if (!closeMatch || closeMatch.index > nextOpenStart) {
      if (i === opens.length - 1 && !closeMatch) {
        hasTrailingUnclosedUnit = true;
      }
      continue;
    }
    const zh = rawText
      .slice(cur.bodyStart, closeMatch.index)
      .replace(/^\r?\n/, "")
      .replace(/\r?\n$/, "")
      .trim();
    if (zh.length > 0) {
      translations.push({ unit_id: cur.id, zh });
    }
  }

  return { translations, hasTrailingUnclosedUnit };
}

/**
 * Extracts all complete `<translation id="...">...</translation>` blocks from raw LLM output
 * (also accepting `<unit id="...">...</unit>` as a fallback), tolerating optional markdown code
 * fences, extra attributes, and mid-stream truncation.
 */
export function parseUnitFenceTranslations(rawText: string): ParsedUnitTranslation[] {
  return parseUnitFenceResult(rawText).translations;
}

export const salvageTruncatedTranslations = parseUnitFenceTranslations;

interface InternalGenerateResult {
  object: { translations: ParsedUnitTranslation[] };
  text: string;
  inputTokens: number;
  exactInput: boolean;
  outputTokens: number;
  exactOutput: boolean;
  tokPerSec?: number;
  genMs: number;
  hasTrailingUnclosedUnit: boolean;
  finishReason?: string;
  usage?: GenerateTranslationCallResult["usage"];
  response?: GenerateTranslationCallResult["response"];
}

interface FetchObserver {
  onRequestStart?: () => void;
  onHeadersReceived?: () => void;
  tapOpenAiReasoning?: (delta: string) => void;
  omitTemperature?: boolean;
}

function createStreamingTokenEstimator() {
  let ascii = 0;
  let nonAscii = 0;
  return {
    add(delta: string): number {
      for (let i = 0; i < delta.length; i++) {
        if (delta.charCodeAt(i) < 0x80) ascii++;
        else nonAscii++;
      }
      return Math.ceil(ascii / 3.5 + nonAscii * 1.1);
    },
    current(): number {
      return Math.ceil(ascii / 3.5 + nonAscii * 1.1);
    },
  };
}

function estimatePromptTokens(
  system: string,
  messages: ReadonlyArray<TranslationChatMessage>,
): number {
  let total = estimateTokens(system) + 4;
  for (const msg of messages) {
    total += estimateTokens(msg.content) + 4;
  }
  return total;
}

function computeStreamTokPerSec(
  outputTokens: number,
  firstChunkAt: number,
  now: number,
): number | undefined {
  if (outputTokens <= 0) return undefined;
  const elapsedMs = now - firstChunkAt;
  if (elapsedMs < 150) return undefined;
  return outputTokens / (elapsedMs / 1000);
}

function computeFinalTokPerSec(
  outputTokens: number,
  callStartedAt: number,
  firstChunkAt: number | null,
  finishedAt: number,
): { tokPerSec?: number; genMs: number } {
  if (outputTokens <= 0) return { genMs: 0 };
  const streamMs = firstChunkAt !== null ? finishedAt - firstChunkAt : 0;
  const totalMs = finishedAt - callStartedAt;
  const genMs = streamMs >= 100 ? streamMs : totalMs;
  if (genMs < 20) return { genMs };
  return {
    tokPerSec: outputTokens / (genMs / 1000),
    genMs,
  };
}

function normalizeUsage(
  raw?: GenerateTranslationCallResult["usage"],
): GenerateTranslationCallResult["usage"] {
  if (!raw) return undefined;
  const promptOk = Number.isFinite(raw.promptTokens);
  const completionOk = Number.isFinite(raw.completionTokens);
  if (!promptOk && !completionOk) return undefined;
  const promptTokens = promptOk ? raw.promptTokens : 0;
  const completionTokens = completionOk ? raw.completionTokens : 0;
  const totalTokens = Number.isFinite(raw.totalTokens)
    ? raw.totalTokens
    : promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

async function runGenerateCall(
  opts: GenerateTranslationCallOptions,
  estimatedInputTokens: number,
  fetchObserver?: { current?: FetchObserver },
): Promise<InternalGenerateResult> {
  const callStartedAt = performance.now();
  let firstChunkAt: number | null = null;

  if (activeGenerateOverride) {
    const estimator = createStreamingTokenEstimator();
    const res = await activeGenerateOverride({
      ...opts,
      onHeadersReceived: () => {
        opts.onHeadersReceived?.();
      },
      onStreamChunk: (deltaText) => {
        const now = performance.now();
        if (firstChunkAt === null) firstChunkAt = now;
        const est = estimator.add(deltaText);
        const rate = computeStreamTokPerSec(est, firstChunkAt, now);
        opts.onStreamChunk?.(deltaText, est, rate);
      },
    });
    const finishedAt = performance.now();
    const text =
      res.text ?? (res.object ? formatUnitFenceTranslations(res.object.translations) : "");
    const parsed = res.object
      ? { translations: res.object.translations, hasTrailingUnclosedUnit: false }
      : parseUnitFenceResult(text);
    const exactInput = Number.isFinite(res.usage?.promptTokens);
    const inputTokens = exactInput ? res.usage!.promptTokens : estimatedInputTokens;
    const exactOutput = Number.isFinite(res.usage?.completionTokens);
    const outputTokens = exactOutput
      ? res.usage!.completionTokens
      : Math.max(estimator.current(), estimateTokens(text));
    const { tokPerSec, genMs } = computeFinalTokPerSec(
      outputTokens,
      callStartedAt,
      firstChunkAt,
      finishedAt,
    );
    return {
      object: { translations: parsed.translations },
      text,
      inputTokens,
      exactInput,
      outputTokens,
      exactOutput,
      tokPerSec,
      genMs,
      hasTrailingUnclosedUnit: parsed.hasTrailingUnclosedUnit,
      finishReason: res.finishReason,
      usage: normalizeUsage(res.usage),
      response: res.response,
    };
  }

  const textChunks: string[] = [];
  const estimator = createStreamingTokenEstimator();
  let streamStarted = false;

  const recordStreamDelta = (delta: string) => {
    if (delta.length === 0) return;
    streamStarted = true;
    const now = performance.now();
    if (firstChunkAt === null) firstChunkAt = now;
    const est = estimator.add(delta);
    const rate = computeStreamTokPerSec(est, firstChunkAt, now);
    opts.onStreamChunk?.(delta, est, rate);
  };

  const includeTemperature = opts.reasoningEffort === undefined || opts.reasoningEffort === "none";

  if (fetchObserver) {
    fetchObserver.current = {
      onHeadersReceived: () => {
        if (!streamStarted) {
          opts.onHeadersReceived?.();
        }
      },
      tapOpenAiReasoning: (delta) => {
        recordStreamDelta(delta);
      },
      omitTemperature: !includeTemperature,
    };
  }

  try {
    // Intentionally omit `maxTokens`: token budgets are soft caps for document/pass splitting guidance only, never enforced in the AI API call.
    const stream = streamText({
      model: opts.model,
      ...(includeTemperature ? { temperature: 0 } : {}),
      ...(opts.providerOptions ? { providerOptions: opts.providerOptions as never } : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      system: opts.system,
      messages: opts.messages,
      onError: () => {},
    });

    let finishReason: string | undefined;
    let rawUsage: GenerateTranslationCallResult["usage"];
    let responseMeta: GenerateTranslationCallResult["response"];

    for await (const part of stream.fullStream) {
      if (part.type === "text-delta") {
        if (part.textDelta.length > 0) {
          textChunks.push(part.textDelta);
          recordStreamDelta(part.textDelta);
        }
      } else if (part.type === "reasoning") {
        recordStreamDelta(part.textDelta);
      } else if (part.type === "finish") {
        finishReason = part.finishReason;
        rawUsage = part.usage;
        responseMeta = {
          id: part.response.id,
          modelId: part.response.modelId,
        };
      } else if (part.type === "error") {
        throw part.error;
      }
    }

    const finishedAt = performance.now();
    const text = textChunks.join("");
    const parsed = parseUnitFenceResult(text);
    const exactInput = Number.isFinite(rawUsage?.promptTokens);
    const inputTokens = exactInput ? rawUsage!.promptTokens : estimatedInputTokens;
    const exactOutput = Number.isFinite(rawUsage?.completionTokens);
    const outputTokens = exactOutput ? rawUsage!.completionTokens : estimator.current();
    const { tokPerSec, genMs } = computeFinalTokPerSec(
      outputTokens,
      callStartedAt,
      firstChunkAt,
      finishedAt,
    );
    return {
      object: { translations: parsed.translations },
      text,
      inputTokens,
      exactInput,
      outputTokens,
      exactOutput,
      tokPerSec,
      genMs,
      hasTrailingUnclosedUnit: parsed.hasTrailingUnclosedUnit,
      finishReason,
      usage: normalizeUsage(rawUsage),
      response: responseMeta,
    };
  } finally {
    if (fetchObserver) {
      fetchObserver.current = undefined;
    }
  }
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

const INLINE_CODE_FENCE_RE = /^(-{4,}|\.{4,}|\+{4,}|`{3,})(.*)$/;

function extractInlineCodeSpans(text: string): string[] {
  // Strip AsciiDoc curved quotation marks ("`...`" and '`...`', which may wrap across lines)
  // before scanning line-by-line for verbatim fences and inline monospace (`...` / ``...``).
  const withoutCurvedQuotes = text
    .replace(/\r\n?/g, "\n")
    .replace(/"`[^`]*`"|'`[^`]*`'/g, " ");
  const spans: string[] = [];
  let activeFence: string | null = null;

  for (const rawLine of withoutCurvedQuotes.split("\n")) {
    const trimmed = rawLine.trim();
    if (activeFence !== null) {
      if (
        trimmed === activeFence ||
        (activeFence.startsWith("`") && trimmed.startsWith(activeFence) && /^`+$/.test(trimmed))
      ) {
        activeFence = null;
      }
      continue;
    }

    const fenceMatch = INLINE_CODE_FENCE_RE.exec(trimmed);
    if (fenceMatch) {
      const delim = fenceMatch[1];
      const rest = fenceMatch[2].trim();
      if (delim.startsWith("`")) {
        activeFence = delim.slice(0, 3);
        continue;
      }
      if (rest === "") {
        activeFence = delim;
        continue;
      }
    }

    // Ignore legacy LaTeX double-backtick quotes (``word'') before matching ``code`` or `code`,
    // and normalize both constrained (`...`) and unconstrained (``...``) spans to `...`.
    const line = rawLine.replace(/``[^`\n]+?''/g, " ");
    for (const match of line.matchAll(/`{2,}([^`\n]+?)`{2,}|`([^`\n]+)`/g)) {
      const inner = match[1] ?? match[2];
      spans.push(`\`${inner}\``);
    }
  }

  return spans;
}

function extractXrefTargets(text: string): string[] {
  return [...text.matchAll(/<<([^>\n]+)>>/g)].map((m) => {
    const inner = m[1];
    const commaIdx = inner.indexOf(",");
    return (commaIdx >= 0 ? inner.slice(0, commaIdx) : inner).trim();
  });
}

function extractMathExpressions(text: string): string[] {
  return [...text.matchAll(/(?:stem|latexmath):\[(?:[^\]\\]|\\.)*\]/g)].map((m) => m[0]);
}

/**
 * Verifies that structural invariants (inline backticks, <<xref>> targets,
 * stem/latexmath blocks, RISC-V custom macros, and markerless headings) are preserved from EN to ZH.
 */
export function validateTranslationStructure(
  en: string,
  zh: string,
  kind?: BlockKind,
): ValidationResult {
  const errors: string[] = [];

  if (en.trim().length > 0 && zh.trim().length === 0) {
    errors.push("Translated text is empty.");
    return { ok: false, errors };
  }

  // 1. Inline backtick code spans
  const enCode = countTokens(extractInlineCodeSpans(en));
  const zhCode = countTokens(extractInlineCodeSpans(zh));
  for (const [token, count] of enCode) {
    if ((zhCode.get(token) ?? 0) < count) {
      errors.push(`Missing inline code span: ${token}`);
    }
  }
  for (const match of zh.matchAll(/[“‘]`([^`\n]+)`[”’]/g)) {
    const span = `\`${match[1]}\``;
    if (!enCode.has(span)) {
      errors.push(
        `Malformed curved quote around non-code text (${match[0]}): use Chinese quotes (“...” / ‘...’) without backticks.`,
      );
    }
  }

  // 2. <<xref>> targets
  const enXrefs = countTokens(extractXrefTargets(en));
  const zhXrefs = countTokens(extractXrefTargets(zh));
  for (const [target, count] of enXrefs) {
    if ((zhXrefs.get(target) ?? 0) < count) {
      errors.push(`Missing cross-reference target: <<${target}>>`);
    }
  }

  // 3. stem:[...] and latexmath:[...] expressions
  const enMath = countTokens(extractMathExpressions(en));
  const zhMath = countTokens(extractMathExpressions(zh));
  for (const [expr, count] of enMath) {
    if ((zhMath.get(expr) ?? 0) < count) {
      errors.push(`Missing math expression: ${expr}`);
    }
  }

  // 4. RISC-V custom inline macros
  const enMacros = countTokens(extractRiscvMacroTokens(en));
  const zhMacros = countTokens(extractRiscvMacroTokens(zh));
  for (const [token, count] of enMacros) {
    if ((zhMacros.get(token) ?? 0) < count) {
      errors.push(`Missing RISC-V macro: ${token}`);
    }
  }

  // 5. Headings are stored without leading AsciiDoc '=' markers
  if (kind === "heading" && /^=+\s+/.test(zh.trim())) {
    errors.push("Heading translation must not start with AsciiDoc '=' markers.");
  }

  return { ok: errors.length === 0, errors };
}

export function resolveReasoningEffort(explicit?: string): ReasoningEffort | undefined {
  if (explicit !== undefined) {
    const normalized = explicit.trim().toLowerCase();
    if (normalized && (REASONING_EFFORT_VALUES as readonly string[]).includes(normalized)) {
      return normalized as ReasoningEffort;
    }
    throw new Error(
      `Invalid AI_REASONING_EFFORT value: "${explicit}". Expected one of: ${REASONING_EFFORT_VALUES.join(", ")}.`,
    );
  }
  const raw = process.env.AI_REASONING_EFFORT?.trim();
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if ((REASONING_EFFORT_VALUES as readonly string[]).includes(normalized)) {
    return normalized as ReasoningEffort;
  }
  throw new Error(
    `Invalid AI_REASONING_EFFORT value: "${raw}". Expected one of: ${REASONING_EFFORT_VALUES.join(", ")}.`,
  );
}

/**
 * Maps the unified reasoning effort level to each provider SDK's `providerOptions` structure.
 */
export function buildReasoningProviderOptions(
  provider: Exclude<SupportedProvider, "mock">,
  effort: ReasoningEffort | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (!effort) return undefined;
  switch (provider) {
    case "openai":
      return { openai: { reasoningEffort: effort } };
    case "deepseek":
      // `@ai-sdk/openai-compatible` spreads `providerMetadata.deepseek` verbatim onto the JSON body,
      // whereas `providerMetadata["openai-compatible"].reasoningEffort` maps cleanly to `reasoning_effort`.
      return { "openai-compatible": { reasoningEffort: effort } };
    case "google": {
      const thinkingBudget = {
        none: 0,
        minimal: 512,
        low: 1024,
        medium: 8192,
        high: 16384,
        xhigh: 24576,
      }[effort];
      return { google: { thinkingConfig: { thinkingBudget } } };
    }
    case "anthropic": {
      if (effort === "none") {
        return { anthropic: { thinking: { type: "disabled" } } };
      }
      const budgetTokens = {
        minimal: 1024,
        low: 2048,
        medium: 8192,
        high: 16384,
        xhigh: 32000,
      }[effort];
      return { anthropic: { thinking: { type: "enabled", budgetTokens } } };
    }
  }
}

export function resolveProvider(provider?: string): SupportedProvider {
  const raw = (provider?.trim() || process.env.AI_PROVIDER?.trim() || "openai").toLowerCase();
  if (
    raw === "deepseek" ||
    raw === "google" ||
    raw === "openai" ||
    raw === "anthropic" ||
    raw === "mock"
  ) {
    return raw;
  }
  throw new Error(
    `Unsupported AI provider: ${raw}. Expected deepseek, google, openai, anthropic, or mock.`,
  );
}

export function defaultModelForProvider(provider: SupportedProvider): string {
  switch (provider) {
    case "deepseek":
      return "deepseek-flash";
    case "google":
      return "gemini-4-hydrogen";
    case "openai":
      return "gpt-6-luna";
    case "anthropic":
      return "claude-haiku-5-5";
    case "mock":
      return "mock-deterministic";
  }
}

function getProviderBaseUrlFromEnv(provider: Exclude<SupportedProvider, "mock">): string | undefined {
  switch (provider) {
    case "deepseek":
      return process.env.DEEPSEEK_BASE_URL?.trim() || undefined;
    case "google":
      return process.env.GOOGLE_GENERATIVE_AI_BASE_URL?.trim() || undefined;
    case "openai":
      return process.env.OPENAI_BASE_URL?.trim() || undefined;
    case "anthropic":
      return process.env.ANTHROPIC_BASE_URL?.trim() || undefined;
  }
}

function resolveBaseUrl(
  provider: Exclude<SupportedProvider, "mock">,
  baseUrl?: string,
): string | undefined {
  return (
    baseUrl?.trim() || getProviderBaseUrlFromEnv(provider) || process.env.AI_BASE_URL?.trim() || undefined
  );
}

function extractSseReasoningDelta(line: string): string {
  if (!line.startsWith("data:")) return "";
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return "";
  try {
    const parsed = JSON.parse(payload) as {
      choices?: Array<{
        delta?: { reasoning_content?: unknown; reasoning?: unknown };
      }>;
    };
    const delta = parsed.choices?.[0]?.delta;
    if (typeof delta?.reasoning_content === "string") return delta.reasoning_content;
    if (typeof delta?.reasoning === "string") return delta.reasoning;
  } catch {
    // Ignore malformed SSE lines; downstream SDK parser handles stream integrity.
  }
  return "";
}

function createObservedFetch(
  provider: Exclude<SupportedProvider, "mock">,
  fetchObserver?: { current?: FetchObserver },
): typeof fetch {
  return (async (input, init) => {
    fetchObserver?.current?.onRequestStart?.();
    let nextInit = init;
    if (
      (provider === "openai" || provider === "deepseek") &&
      fetchObserver?.current?.omitTemperature &&
      typeof init?.body === "string"
    ) {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        if (parsed && typeof parsed === "object" && "temperature" in parsed) {
          delete parsed.temperature;
          nextInit = { ...init, body: JSON.stringify(parsed) };
        }
      } catch {
        // Leave non-JSON request bodies untouched.
      }
    }
    const res = await globalThis.fetch(input, nextInit);
    if (res.ok) {
      fetchObserver?.current?.onHeadersReceived?.();
    }
    if (
      provider === "openai" &&
      res.ok &&
      res.body &&
      fetchObserver?.current?.tapOpenAiReasoning &&
      res.headers.get("content-type")?.includes("text/event-stream")
    ) {
      const tap = fetchObserver.current.tapOpenAiReasoning;
      const decoder = new TextDecoder();
      let lineBuffer = "";
      const drainSseLines = (text: string, flushAll: boolean) => {
        lineBuffer += text;
        let nlIdx = lineBuffer.indexOf("\n");
        while (nlIdx >= 0) {
          const delta = extractSseReasoningDelta(lineBuffer.slice(0, nlIdx).trim());
          lineBuffer = lineBuffer.slice(nlIdx + 1);
          if (delta.length > 0) tap(delta);
          nlIdx = lineBuffer.indexOf("\n");
        }
        if (flushAll && lineBuffer.length > 0) {
          const delta = extractSseReasoningDelta(lineBuffer.trim());
          lineBuffer = "";
          if (delta.length > 0) tap(delta);
        }
      };

      const tappedBody = res.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
            drainSseLines(decoder.decode(chunk, { stream: true }), false);
          },
          flush() {
            drainSseLines(decoder.decode(), true);
          },
        }),
      );
      return new Response(tappedBody, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    }
    return res;
  }) as typeof fetch;
}

function getLanguageModel(
  provider: Exclude<SupportedProvider, "mock">,
  modelId: string,
  effectiveBaseUrl?: string,
  fetchObserver?: { current?: FetchObserver },
): LanguageModel {
  const customFetch = createObservedFetch(provider, fetchObserver);
  switch (provider) {
    case "deepseek":
      return createDeepSeek({
        ...(effectiveBaseUrl ? { baseURL: effectiveBaseUrl } : {}),
        fetch: customFetch,
      })(modelId);
    case "google":
      return createGoogleGenerativeAI({
        ...(effectiveBaseUrl ? { baseURL: effectiveBaseUrl } : {}),
        fetch: customFetch,
      })(modelId);
    case "openai":
      // `compatibility: "strict"` enables `stream_options: { include_usage: true }` on SSE streams
      // even when a custom `baseURL` is configured, so exact prompt/completion token usage is reported.
      return createOpenAI({
        ...(effectiveBaseUrl ? { baseURL: effectiveBaseUrl } : {}),
        compatibility: "strict",
        fetch: customFetch,
      })(modelId);
    case "anthropic":
      return createAnthropic({
        ...(effectiveBaseUrl ? { baseURL: effectiveBaseUrl } : {}),
        fetch: customFetch,
      })(modelId);
  }
}

function truncateText(text: string, maxLen = 300): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return `${singleLine.slice(0, maxLen)}...`;
}

function describeLlmError(err: unknown): string {
  if (RetryError.isInstance(err)) {
    const inner = err.lastError ? describeLlmError(err.lastError) : err.message;
    return `${err.message} (last error: ${inner})`;
  }

  if (APICallError.isInstance(err)) {
    const parts: string[] = [];
    parts.push(err.statusCode !== undefined ? `HTTP ${err.statusCode} ${err.message}` : err.message);
    if (err.url) {
      parts.push(`url: ${err.url}`);
    }
    const body = err.responseBody ? truncateText(err.responseBody) : "";
    if (body) {
      parts.push(`response: ${body}`);
    }
    return parts.join(" | ");
  }

  if (NoObjectGeneratedError.isInstance(err)) {
    const causeMsg =
      err.cause instanceof Error ? err.cause.message : err.cause ? String(err.cause) : "";
    const parts = [err.message];
    if (causeMsg) parts.push(`cause: ${causeMsg}`);
    if (err.text) parts.push(`raw: ${truncateText(err.text)}`);
    return parts.join(" | ");
  }

  if (LoadAPIKeyError.isInstance(err) || AISDKError.isInstance(err)) {
    const causeMsg =
      err.cause instanceof Error ? err.cause.message : err.cause ? String(err.cause) : "";
    return causeMsg ? `${err.name}: ${err.message} (cause: ${causeMsg})` : `${err.name}: ${err.message}`;
  }

  if (err instanceof Error) {
    const causeMsg =
      err.cause instanceof Error ? err.cause.message : err.cause ? String(err.cause) : "";
    return causeMsg ? `${err.message} (cause: ${causeMsg})` : err.message;
  }

  return String(err);
}

function formatLlmCallError(
  err: unknown,
  ctx: {
    provider: string;
    modelId: string;
    baseUrl?: string;
    reasoningEffort?: ReasoningEffort;
    attempt: number;
    maxAttempts: number;
    chapterTitle: string;
  },
): Error {
  const targetMeta = [
    `${ctx.provider}/${ctx.modelId}`,
    ...(ctx.baseUrl ? [`baseUrl=${ctx.baseUrl}`] : []),
    ...(ctx.reasoningEffort ? [`reasoning=${ctx.reasoningEffort}`] : []),
    `attempt ${ctx.attempt}/${ctx.maxAttempts}`,
    `chapter "${ctx.chapterTitle}"`,
  ].join(", ");

  return new Error(`LLM call failed (${targetMeta}): ${describeLlmError(err)}`, { cause: err });
}

function mockTranslateUnit(target: TranslationTarget): string {
  const text = target.en;
  if (target.kind === "heading") {
    return `[ZH] ${stripHeadingMarkers(text)}`;
  }

  if (target.kind === "list") {
    const lines = text.split("\n");
    return lines
      .map((line) => {
        const listMatch = line.match(/^(\s*(?:\*+|\.+|-|[^\s:]+::)\s+)(.+)$/);
        if (listMatch) {
          return `${listMatch[1]}[ZH] ${listMatch[2]}`;
        }
        return line;
      })
      .join("\n");
  }

  if (target.kind === "table") {
    const lines = text.split("\n");
    let annotated = false;
    return lines
      .map((line) => {
        const trimmed = line.trim();
        if (
          trimmed === "|===" ||
          trimmed.startsWith("[") ||
          trimmed.startsWith(".") ||
          trimmed.length === 0
        ) {
          return line;
        }
        if (line.startsWith("| ") && !annotated) {
          annotated = true;
          return `| [ZH] ${line.slice(2)}`;
        }
        return line;
      })
      .join("\n");
  }

  if (target.kind === "block") {
    const lines = text.split("\n");
    const out: string[] = [];
    let inserted = false;
    for (const line of lines) {
      const trimmed = line.trim();
      const isStructural =
        trimmed === "====" ||
        trimmed === "----" ||
        trimmed === "****" ||
        trimmed === "--" ||
        trimmed === "____" ||
        trimmed.startsWith("[") ||
        trimmed.startsWith(".");
      if (!isStructural && !inserted && trimmed.length > 0) {
        out.push(`[ZH] ${line}`);
        inserted = true;
      } else {
        out.push(line);
      }
    }
    return out.join("\n");
  }

  return `[ZH] ${text}`;
}

function formatWordDiff(prevEn: string, currEn: string): string {
  const parts = diffWords(prevEn, currEn);
  return parts
    .map((part) => {
      if (part.added) return `{+${part.value}+}`;
      if (part.removed) return `[-${part.value}-]`;
      return part.value;
    })
    .join("");
}

/**
 * Estimates LLM token count for mixed ASCII and non-ASCII (e.g. CJK) text.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 0x80) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 3.5 + nonAscii * 1.1);
}

function estimateTargetOutputTokens(target: TranslationTarget): number {
  return 28 + Math.ceil(estimateTokens(target.en) * 1.35);
}

function resolveTokenBudget(
  explicit: number | undefined,
  envKey: string,
  fallback: number,
): number {
  if (explicit !== undefined) {
    if (!Number.isFinite(explicit) || explicit <= 0) {
      throw new Error(`Invalid ${envKey} value: ${explicit}`);
    }
    return Math.floor(explicit);
  }
  const raw = process.env[envKey]?.trim();
  if (raw) {
    const num = Number(raw);
    if (!Number.isInteger(num) || num <= 0) {
      throw new Error(`Invalid ${envKey} value: "${raw}". Expected a positive integer.`);
    }
    return num;
  }
  return fallback;
}

function buildSystemPrompt(glossaryMarkdown: string): string {
  return [
    "You are translating the official RISC-V Instruction Set Manual into Simplified Chinese.",
    "Follow the authoritative terminology and rules in GLOSSARY.md below strictly.",
    "Preserve all AsciiDoc structure, inline code backticks (`...`), cross-references (<<...>>), math (stem:[...], latexmath:[...]), RISC-V custom inline macros (insn:...[], csr:...[], ext:...[], extlink:...[], insnlink:...[], qty:...[]; normalize legacy inst:...[] to insn:...[], and never wrap these macros in backticks), and numeric/hex literals exactly.",
    "When _..._, *...*, or [#id]#...# touches Chinese characters without spaces, use unconstrained double delimiters (__...__, **...**, [#id]##...##); translate AsciiDoc curved quotes (\"`...`\", '`...`') into Chinese quotation marks (“...”, ‘...’) without inner backticks (never write “`...`”).",
    "Keep all Arabic numerals (e.g., 0, 1, 2, 32) as digits; do not convert them into Chinese numerals (e.g., 一, 二, 两) or Unicode superscripts.",
    "Heading units contain plain title text without leading `= `/`== ` markers; do NOT add leading `=` markers to heading translations.",
    "Unwrapped text outside <unit> is read-only chapter context (already-translated blocks appear as English followed by their Simplified Chinese translation); translate ONLY <unit> blocks and output ONLY Simplified Chinese.",
    "When a <change_history unit_id=\"...\"> block (<diff> and <previous_translation>) precedes a <unit>, modify only the clauses affected by <diff> while keeping the rest of <previous_translation> intact.",
    "When <target_ids> is present at the end of the user message, output translations ONLY for those listed unit IDs.",
    "",
    '<rule_file name="GLOSSARY.md">',
    glossaryMarkdown.trim(),
    "</rule_file>",
    "",
    'Output ONLY translated <translation id="...">...</translation> blocks (one per target <unit>), with raw AsciiDoc inside each block and no outer prose or markdown code fences:',
    '<translation id="...">',
    "<Simplified Chinese AsciiDoc translation>",
    "</translation>",
  ].join("\n");
}

function formatTargetBlock(target: TranslationTarget): string {
  const lines: string[] = [];
  if (target.prev_en !== undefined && target.prev_zh !== undefined) {
    lines.push(`<change_history unit_id="${target.unit_id}">`);
    lines.push("<diff>");
    lines.push(formatWordDiff(target.prev_en, target.en));
    lines.push("</diff>");
    lines.push("<previous_translation>");
    lines.push(target.prev_zh);
    lines.push("</previous_translation>");
    lines.push("</change_history>");
  }
  lines.push(`<unit id="${target.unit_id}" kind="${target.kind}">`);
  lines.push(target.en);
  lines.push("</unit>");
  return lines.join("\n");
}

const PROMPT_HEADER = "Translate each target unit below into Simplified Chinese.";
const PROMPT_FOOTER = 'Output ONLY the translated <translation id="...">...</translation> blocks.';

function formatContextBlock(block: ChapterContextBlock, includeContextZh: boolean): string {
  const enText = block.kind === "heading" ? `== ${block.en}` : block.en;
  if (includeContextZh && block.zh && block.zh !== block.en) {
    const zhText = block.kind === "heading" ? `== ${block.zh}` : block.zh;
    return `${enText}\n${zhText}`;
  }
  return enText;
}

function renderChapterBody(
  chapterBlocks: ChapterContextBlock[],
  targets: TranslationTarget[],
  includeContextZh: boolean,
): string {
  const targetById = new Map(targets.map((t) => [t.unit_id, t]));
  const sections: string[] = [];
  const emittedTargetIds = new Set<string>();

  for (const block of chapterBlocks) {
    const target = targetById.get(block.unit_id);
    if (target) {
      emittedTargetIds.add(target.unit_id);
      sections.push(formatTargetBlock(target));
      continue;
    }

    sections.push(formatContextBlock(block, includeContextZh));
  }

  for (const target of targets) {
    if (!emittedTargetIds.has(target.unit_id)) {
      sections.push(formatTargetBlock(target));
    }
  }

  return sections.join("\n\n");
}

function buildTier3WindowBody(
  chapterBlocks: ChapterContextBlock[],
  activeTargets: TranslationTarget[],
  bodyBudget: number,
): string {
  const activeById = new Map(activeTargets.map((t) => [t.unit_id, t]));
  const selected = new Set<number>();
  const seenTargetIds = new Set<string>();
  const renderedBlocks: string[] = [];
  const blockCosts: number[] = [];

  let usedTokens = 0;
  let minIdx = chapterBlocks.length;
  let maxIdx = -1;

  for (let i = 0; i < chapterBlocks.length; i++) {
    const block = chapterBlocks[i];
    const target = activeById.get(block.unit_id);
    const rendered = target ? formatTargetBlock(target) : formatContextBlock(block, false);
    const cost = estimateTokens(rendered) + 2;
    renderedBlocks.push(rendered);
    blockCosts.push(cost);

    if (target) {
      selected.add(i);
      seenTargetIds.add(target.unit_id);
      usedTokens += cost;
      if (i < minIdx) minIdx = i;
      if (i > maxIdx) maxIdx = i;
    }
  }

  const orphanBlocks: string[] = [];
  for (const target of activeTargets) {
    if (!seenTargetIds.has(target.unit_id)) {
      const rendered = formatTargetBlock(target);
      orphanBlocks.push(rendered);
      usedTokens += estimateTokens(rendered) + 2;
    }
  }

  // Always prefer keeping the chapter heading if there is budget headroom
  if (
    chapterBlocks.length > 0 &&
    !selected.has(0) &&
    (chapterBlocks[0].kind === "heading" || chapterBlocks[0].en.trimStart().startsWith("=")) &&
    usedTokens + blockCosts[0] <= bodyBudget
  ) {
    selected.add(0);
    usedTokens += blockCosts[0];
  }

  // Keep interior context (e.g. diagrams/headings between active units) if budget permits
  for (let i = minIdx + 1; i < maxIdx; i++) {
    if (!selected.has(i) && usedTokens + blockCosts[i] <= bodyBudget) {
      selected.add(i);
      usedTokens += blockCosts[i];
    }
  }

  // Expand contiguously outward before/after the active target span
  if (minIdx <= maxIdx) {
    let leftIdx = minIdx - 1;
    let rightIdx = maxIdx + 1;
    while (leftIdx >= 0 || rightIdx < chapterBlocks.length) {
      if (leftIdx >= 0) {
        if (selected.has(leftIdx)) {
          leftIdx--;
        } else if (usedTokens + blockCosts[leftIdx] <= bodyBudget) {
          selected.add(leftIdx);
          usedTokens += blockCosts[leftIdx];
          leftIdx--;
        } else {
          leftIdx = -1;
        }
      }
      if (rightIdx < chapterBlocks.length) {
        if (selected.has(rightIdx)) {
          rightIdx++;
        } else if (usedTokens + blockCosts[rightIdx] <= bodyBudget) {
          selected.add(rightIdx);
          usedTokens += blockCosts[rightIdx];
          rightIdx++;
        } else {
          rightIdx = chapterBlocks.length;
        }
      }
    }
  }

  const sections: string[] = [];
  for (let i = 0; i < chapterBlocks.length; i++) {
    if (selected.has(i)) {
      sections.push(renderedBlocks[i]);
    }
  }
  sections.push(...orphanBlocks);
  return sections.join("\n\n");
}

function sliceTargetsIntoPasses(
  targets: TranslationTarget[],
  maxOutputTokens: number,
  tier3InputCap: number | null,
): TranslationTarget[][] {
  const passes: TranslationTarget[][] = [];
  let current: TranslationTarget[] = [];
  let passOutTokens = 0;
  let passInTokens = 0;

  for (const target of targets) {
    const unitOutTokens = estimateTargetOutputTokens(target);
    const unitInTokens = estimateTokens(formatTargetBlock(target)) + 2;
    const exceedsOutput = current.length > 0 && passOutTokens + unitOutTokens > maxOutputTokens;
    const exceedsInput =
      tier3InputCap !== null && current.length > 0 && passInTokens + unitInTokens > tier3InputCap;

    if (exceedsOutput || exceedsInput) {
      passes.push(current);
      current = [];
      passOutTokens = 0;
      passInTokens = 0;
    }

    current.push(target);
    passOutTokens += unitOutTokens;
    passInTokens += unitInTokens;
  }

  if (current.length > 0) {
    passes.push(current);
  }
  return passes;
}

function buildPassPrompt(params: {
  sharedChapterBody: string | null;
  chapterBlocks: ChapterContextBlock[];
  activeTargets: TranslationTarget[];
  totalTargetsCount: number;
  passIdx: number;
  totalPasses: number;
  bodyBudget: number;
}): string {
  const {
    sharedChapterBody,
    chapterBlocks,
    activeTargets,
    totalTargetsCount,
    passIdx,
    totalPasses,
    bodyBudget,
  } = params;

  if (sharedChapterBody !== null) {
    if (totalPasses === 1 && activeTargets.length === totalTargetsCount) {
      return [PROMPT_HEADER, sharedChapterBody, PROMPT_FOOTER].join("\n\n");
    }
    const passLabel =
      totalPasses > 1
        ? `Translate ONLY the following <unit> IDs in this pass (pass ${passIdx + 1}/${totalPasses}):`
        : "Translate ONLY the following <unit> IDs in this pass:";
    const targetIdsBlock = `${passLabel}\n<target_ids>\n${activeTargets
      .map((t) => t.unit_id)
      .join("\n")}\n</target_ids>`;
    return [PROMPT_HEADER, sharedChapterBody, targetIdsBlock, PROMPT_FOOTER].join("\n\n");
  }

  const windowBody = buildTier3WindowBody(chapterBlocks, activeTargets, bodyBudget);
  return [PROMPT_HEADER, windowBody, PROMPT_FOOTER].join("\n\n");
}

function buildRetryPrompt(
  failedTargets: TranslationTarget[],
  retryErrors: Map<string, string[]>,
): string {
  const lines: string[] = [
    "The following units did not pass validation, please output a new version of the translation of ONLY these units and fix the error.",
  ];
  for (const target of failedTargets) {
    const errors = retryErrors.get(target.unit_id) ?? ["Unknown validation error."];
    lines.push(`<error unit_id="${target.unit_id}">`);
    lines.push(errors.join("\n"));
    lines.push("</error>");
  }
  return lines.join("\n");
}

/**
 * Translates target units within one chapter file using an immutable XML system prefix
 * (for cross-chapter KV prefix caching), full-file user context when within input budget
 * (automatically windowed if exceeded), multi-pass output splitting, truncation salvage,
 * and multi-turn validation retries.
 */
export async function translateChapterBatch(
  opts: TranslateChapterBatchOptions,
): Promise<Map<string, { zh: string; status: TranslationStatus }>> {
  const results = new Map<string, { zh: string; status: TranslationStatus }>();
  if (opts.targets.length === 0) {
    return results;
  }

  const provider = resolveProvider(opts.provider);
  const reasoningEffort = resolveReasoningEffort(opts.reasoningEffort);
  const modelId =
    opts.model?.trim() || process.env.AI_MODEL?.trim() || defaultModelForProvider(provider);
  const maxInputTokens = resolveTokenBudget(
    opts.maxInputTokens,
    "AI_MAX_INPUT_TOKENS",
    DEFAULT_MAX_INPUT_TOKENS,
  );
  const maxOutputTokens = resolveTokenBudget(
    opts.maxOutputTokens,
    "AI_MAX_OUTPUT_TOKENS",
    DEFAULT_MAX_OUTPUT_TOKENS,
  );

  const systemPrompt = buildSystemPrompt(opts.glossaryMarkdown);
  const systemTokens = estimateTokens(systemPrompt);
  const bodyBudget = Math.max(256, maxInputTokens - systemTokens - 320);

  let sharedChapterBody: string | null = null;
  const bilingualBody = renderChapterBody(opts.chapterBlocks, opts.targets, true);
  if (estimateTokens(bilingualBody) <= bodyBudget) {
    sharedChapterBody = bilingualBody;
  } else {
    const hasBilingualContext = opts.chapterBlocks.some(
      (b) => b.zh && b.zh !== b.en && !opts.targets.some((t) => t.unit_id === b.unit_id),
    );
    const enOnlyBody = hasBilingualContext
      ? renderChapterBody(opts.chapterBlocks, opts.targets, false)
      : bilingualBody;
    if (estimateTokens(enOnlyBody) <= bodyBudget) {
      sharedChapterBody = enOnlyBody;
    }
  }

  const tier3InputCap = sharedChapterBody === null ? Math.max(128, Math.floor(bodyBudget * 0.8)) : null;
  const passes = sliceTargetsIntoPasses(opts.targets, maxOutputTokens, tier3InputCap);

  if (provider === "mock") {
    for (let passIdx = 0; passIdx < passes.length; passIdx++) {
      if (opts.abortSignal?.aborted) {
        throw opts.abortSignal.reason ?? new DOMException("The operation was aborted.", "AbortError");
      }
      const passPrompt = buildPassPrompt({
        sharedChapterBody,
        chapterBlocks: opts.chapterBlocks,
        activeTargets: passes[passIdx],
        totalTargetsCount: opts.targets.length,
        passIdx,
        totalPasses: passes.length,
        bodyBudget,
      });
      const passInputTokens = estimatePromptTokens(systemPrompt, [
        { role: "user", content: passPrompt },
      ]);
      opts.onLlmProgress?.({
        phase: "uploading",
        inputTokens: passInputTokens,
        exactInput: false,
        outputTokens: 0,
        exactOutput: false,
        passIndex: passIdx,
        totalPasses: passes.length,
        attempt: 1,
      });
      const passResults = new Map<string, { zh: string; status: TranslationStatus }>();
      const estimator = createStreamingTokenEstimator();
      for (const target of passes[passIdx]) {
        const rawZh = mockTranslateUnit(target);
        const zh = target.kind === "heading" ? stripHeadingMarkers(rawZh) : rawZh;
        const validation = validateTranslationStructure(target.en, zh, target.kind);
        if (!validation.ok) {
          throw new Error(
            `Mock translation failed validation for ${target.unit_id}: ${validation.errors.join("; ")}`,
          );
        }
        const status: TranslationStatus = "machine";
        const entry = { zh, status };
        estimator.add(zh);
        passResults.set(target.unit_id, entry);
        results.set(target.unit_id, entry);
      }
      opts.onLlmProgress?.({
        phase: "finish",
        inputTokens: passInputTokens,
        exactInput: false,
        outputTokens: estimator.current(),
        exactOutput: false,
        passIndex: passIdx,
        totalPasses: passes.length,
        attempt: 1,
      });
      const cont = opts.onPassComplete?.(passResults, { passIndex: passIdx, totalPasses: passes.length });
      if (cont === false) break;
    }
    return results;
  }

  const effectiveBaseUrl = resolveBaseUrl(provider, opts.baseUrl);
  const providerOptions = buildReasoningProviderOptions(provider, reasoningEffort);
  const fetchObserver: { current?: FetchObserver } = {};
  const languageModel = getLanguageModel(provider, modelId, effectiveBaseUrl, fetchObserver);
  const langsmithConfig = resolveLangSmithConfig();
  const trace = langsmithConfig
    ? new LangSmithBatchTrace(langsmithConfig, {
        chapterTitle: opts.chapterTitle,
        provider,
        modelId,
        baseUrl: effectiveBaseUrl,
        targetUnitIds: opts.targets.map((t) => t.unit_id),
        contextBlockCount: opts.chapterBlocks.length,
      })
    : null;

  const maxValidationAttempts = 3; // 1 initial failure + up to 2 validation retries

  try {
    for (let passIdx = 0; passIdx < passes.length; passIdx++) {
      const passTargets = passes[passIdx];
      const passResults = new Map<string, { zh: string; status: TranslationStatus }>();
      let passFlushed = false;
      let pending = [...passTargets];
      let retryErrors = new Map<string, string[]>();
      let previousFailedZh = new Map<string, string>();
      let validationFailures = 0;
      let totalCalls = 0;
      const maxTotalCalls = passTargets.length + 3;

      let messages: TranslationChatMessage[] = [
        {
          role: "user",
          content: buildPassPrompt({
            sharedChapterBody,
            chapterBlocks: opts.chapterBlocks,
            activeTargets: pending,
            totalTargetsCount: opts.targets.length,
            passIdx,
            totalPasses: passes.length,
            bodyBudget,
          }),
        },
      ];

      try {
        while (
          pending.length > 0 &&
          validationFailures < maxValidationAttempts &&
          totalCalls < maxTotalCalls
        ) {
          totalCalls++;
          const displayAttempt = Math.min(validationFailures + 1, maxValidationAttempts);
          const passPrefix = passes.length > 1 ? ` pass ${passIdx + 1}/${passes.length}` : "";
          const reasoningTag = reasoningEffort ? ` (reasoning=${reasoningEffort})` : "";
          vlog(
            2,
            `llm${passPrefix} attempt ${displayAttempt}/${maxValidationAttempts}: ${pending.length} unit(s) via ${provider}/${modelId}${reasoningTag}`,
          );

          const turnMessages = messages.map((m) => ({ ...m }));
          const estimatedInputTokens = estimatePromptTokens(systemPrompt, turnMessages);
          const llmRun = trace?.startLlmRun({
            system: systemPrompt,
            messages: turnMessages,
            provider,
            modelId,
            baseUrl: effectiveBaseUrl,
            attempt: displayAttempt,
            maxAttempts: maxValidationAttempts,
            chapterTitle: opts.chapterTitle,
          });

          let response: InternalGenerateResult;
          let wasSalvagedTruncation = false;
          opts.onLlmProgress?.({
            phase: "uploading",
            inputTokens: estimatedInputTokens,
            exactInput: false,
            outputTokens: 0,
            exactOutput: false,
            passIndex: passIdx,
            totalPasses: passes.length,
            attempt: displayAttempt,
          });
          try {
            response = await runGenerateCall(
              {
                model: languageModel,
                system: systemPrompt,
                messages: turnMessages,
                prompt: turnMessages[turnMessages.length - 1].content,
                reasoningEffort,
                providerOptions,
                abortSignal: opts.abortSignal,
                onHeadersReceived: () => {
                  opts.onLlmProgress?.({
                    phase: "waiting",
                    inputTokens: estimatedInputTokens,
                    exactInput: false,
                    outputTokens: 0,
                    exactOutput: false,
                    passIndex: passIdx,
                    totalPasses: passes.length,
                    attempt: displayAttempt,
                  });
                },
                onStreamChunk: (_deltaText, estimatedCallTokens, tokPerSec) => {
                  opts.onLlmProgress?.({
                    phase: "stream",
                    inputTokens: estimatedInputTokens,
                    exactInput: false,
                    outputTokens: estimatedCallTokens,
                    exactOutput: false,
                    tokPerSec,
                    passIndex: passIdx,
                    totalPasses: passes.length,
                    attempt: displayAttempt,
                  });
                },
              },
              estimatedInputTokens,
              fetchObserver,
            );
            opts.onLlmProgress?.({
              phase: "finish",
              inputTokens: response.inputTokens,
              exactInput: response.exactInput,
              outputTokens: response.outputTokens,
              exactOutput: response.exactOutput,
              tokPerSec: response.tokPerSec,
              genMs: response.genMs,
              passIndex: passIdx,
              totalPasses: passes.length,
              attempt: displayAttempt,
            });
            llmRun?.finish({
              text: response.text,
              finishReason: response.finishReason,
              usage: response.usage,
              responseId: response.response?.id,
              responseModelId: response.response?.modelId,
            });
          } catch (err) {
            if (NoObjectGeneratedError.isInstance(err) && err.text) {
              const parsed = parseUnitFenceResult(err.text);
              if (parsed.translations.length > 0) {
                wasSalvagedTruncation = true;
                const exactInput = Number.isFinite(err.usage?.promptTokens);
                const inputTokens = exactInput ? err.usage!.promptTokens : estimatedInputTokens;
                const exactOutput = Number.isFinite(err.usage?.completionTokens);
                const outputTokens = exactOutput
                  ? err.usage!.completionTokens
                  : estimateTokens(err.text);
                response = {
                  object: { translations: parsed.translations },
                  text: err.text,
                  inputTokens,
                  exactInput,
                  outputTokens,
                  exactOutput,
                  genMs: 0,
                  hasTrailingUnclosedUnit: parsed.hasTrailingUnclosedUnit,
                  finishReason: err.finishReason ?? "length",
                  usage: normalizeUsage(err.usage),
                  response: err.response,
                };
                opts.onLlmProgress?.({
                  phase: "finish",
                  inputTokens: response.inputTokens,
                  exactInput: response.exactInput,
                  outputTokens: response.outputTokens,
                  exactOutput: response.exactOutput,
                  passIndex: passIdx,
                  totalPasses: passes.length,
                  attempt: displayAttempt,
                });
                llmRun?.finish({
                  text: response.text,
                  finishReason: response.finishReason,
                  usage: response.usage,
                  responseId: response.response?.id,
                  responseModelId: response.response?.modelId,
                });
              } else {
                const formattedErr = formatLlmCallError(err, {
                  provider,
                  modelId,
                  baseUrl: effectiveBaseUrl,
                  reasoningEffort,
                  attempt: displayAttempt,
                  maxAttempts: maxValidationAttempts,
                  chapterTitle: opts.chapterTitle,
                });
                llmRun?.fail(formattedErr);
                throw formattedErr;
              }
            } else {
              const formattedErr = formatLlmCallError(err, {
                provider,
                modelId,
                baseUrl: effectiveBaseUrl,
                reasoningEffort,
                attempt: displayAttempt,
                maxAttempts: maxValidationAttempts,
                chapterTitle: opts.chapterTitle,
              });
              llmRun?.fail(formattedErr);
              throw formattedErr;
            }
          }

          const returnedMap = new Map<string, string>();
          for (const item of response.object.translations) {
            returnedMap.set(item.unit_id, item.zh);
          }

          const nextPending: TranslationTarget[] = [];
          const nextErrors = new Map<string, string[]>();
          const nextFailedZh = new Map<string, string>();
          let succeededCount = 0;

          for (const target of pending) {
            const rawZh = returnedMap.get(target.unit_id);
            if (rawZh === undefined) {
              nextPending.push(target);
              nextErrors.set(target.unit_id, ["Missing unit_id in model output."]);
              continue;
            }

            const zh = target.kind === "heading" ? stripHeadingMarkers(rawZh) : rawZh;
            const check = validateTranslationStructure(target.en, zh, target.kind);
            if (!check.ok) {
              if (isVerbose(3)) {
                vlog(3, `retry unit ${target.unit_id}: ${check.errors.join("; ")}`);
              }
              nextPending.push(target);
              nextErrors.set(target.unit_id, check.errors);
              nextFailedZh.set(target.unit_id, zh);
              continue;
            }

            const status: TranslationStatus = "machine";
            const entry = { zh, status };
            passResults.set(target.unit_id, entry);
            results.set(target.unit_id, entry);
            succeededCount++;
          }

          if (nextPending.length === 0) {
            pending = nextPending;
            break;
          }

          const truncatedWithProgress =
            (response.finishReason === "length" ||
              response.finishReason === "max_tokens" ||
              response.hasTrailingUnclosedUnit ||
              wasSalvagedTruncation) &&
            succeededCount > 0;

          if (truncatedWithProgress) {
            vlog(
              2,
              `llm${passPrefix}: salvaged ${succeededCount} unit(s) before output truncation; continuing ${nextPending.length} remaining`,
            );
            messages = [
              {
                role: "user",
                content: buildPassPrompt({
                  sharedChapterBody,
                  chapterBlocks: opts.chapterBlocks,
                  activeTargets: nextPending,
                  totalTargetsCount: opts.targets.length,
                  passIdx,
                  totalPasses: passes.length,
                  bodyBudget,
                }),
              },
            ];
          } else {
            validationFailures++;
            if (nextErrors.size > 0) {
              trace?.recordValidationRetry(validationFailures, nextErrors);
            }
            if (validationFailures < maxValidationAttempts) {
              messages.push(
                { role: "assistant", content: response.text },
                { role: "user", content: buildRetryPrompt(nextPending, nextErrors) },
              );
            }
          }

          pending = nextPending;
          retryErrors = nextErrors;
          previousFailedZh = nextFailedZh;
        }

        if (pending.length > 0) {
          const summary = pending
            .map((t) => {
              const errs = (retryErrors.get(t.unit_id) ?? ["unknown"]).join("; ");
              const enSnippet = truncateText(t.en, 160);
              const failedZh = previousFailedZh.get(t.unit_id);
              const zhPart = failedZh !== undefined ? ` | ZH: ${truncateText(failedZh, 160)}` : "";
              return `${t.unit_id}: ${errs} [EN: ${enSnippet}${zhPart}]`;
            })
            .join(" | ");
          throw new Error(`Translation validation failed after 2 retries: ${summary}`);
        }

        passFlushed = true;
        const cont = opts.onPassComplete?.(passResults, { passIndex: passIdx, totalPasses: passes.length });
        if (cont === false) break;
      } catch (passErr) {
        if (!passFlushed && passResults.size > 0) {
          passFlushed = true;
          opts.onPassComplete?.(passResults, { passIndex: passIdx, totalPasses: passes.length });
        }
        throw passErr;
      }
    }

    await trace?.finish({
      translatedCount: results.size,
      unitIds: [...results.keys()],
    });
    return results;
  } catch (err) {
    await trace?.fail(err);
    throw err;
  }
}
