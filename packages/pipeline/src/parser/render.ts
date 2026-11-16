import Asciidoctor from "@asciidoctor/core";
import bytefield from "bytefield-svg";
import { decode as decodeHtmlEntities, encode as encodeHtmlEntities } from "he";
import JSON5 from "json5";
import katex from "katex";
import { NodeType, parse, TextNode, type HTMLElement as ParsedHtmlElement } from "node-html-parser";
import onml from "onml";
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import langAsciidoc from "shiki/langs/asciidoc.mjs";
import langC from "shiki/langs/c.mjs";
import langCpp from "shiki/langs/cpp.mjs";
import langDiff from "shiki/langs/diff.mjs";
import langJson from "shiki/langs/json.mjs";
import langMake from "shiki/langs/make.mjs";
import langPython from "shiki/langs/python.mjs";
import langRiscv from "shiki/langs/riscv.mjs";
import langRust from "shiki/langs/rust.mjs";
import langShellscript from "shiki/langs/shellscript.mjs";
import langSystemVerilog from "shiki/langs/system-verilog.mjs";
import langToml from "shiki/langs/toml.mjs";
import langVerilog from "shiki/langs/verilog.mjs";
import langYaml from "shiki/langs/yaml.mjs";
import themeGithubDarkDefault from "shiki/themes/github-dark-default.mjs";
import themeGithubLightDefault from "shiki/themes/github-light-default.mjs";
import wavedrom from "wavedrom";
import type { BlockKind, VolumeId } from "@riscv-cn/schema";
import { expandRiscvMacrosForHtml, formatRiscvExtensionName } from "./macros.ts";

export interface XrefTargetInfo {
  anchor_id: string;
  volume_id: VolumeId;
  chapter_id: string;
  section_id?: string;
  sectnum: string | null;
  sectname?: string;
  kind: BlockKind | "section";
  title_en?: string;
  title_zh?: string;
  is_bibliography?: boolean;
}

const asciidoctor = Asciidoctor();
asciidoctor.LoggerManager.setLogger(asciidoctor.NullLogger.create());

function renderFallbackCode(raw: string): string {
  return `<pre class="diagram-fallback"><code>${encodeHtmlEntities(raw)}</code></pre>`;
}

function renderWaveDrom(body: string, title?: string): string {
  try {
    const parsed = JSON5.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return renderFallbackCode(body);
    }
    const ml = wavedrom.renderAny(
      0,
      parsed as Record<string, unknown>,
      wavedrom.waveSkin,
    );
    const svg = onml.stringify(ml);
    if (!svg.includes("<svg")) {
      return renderFallbackCode(body);
    }
    const caption = title
      ? `<div class="title">${encodeHtmlEntities(title)}</div>`
      : "";
    return `<div class="diagram-svg">${caption}${svg}</div>`;
  } catch {
    return renderFallbackCode(body);
  }
}

function renderBytefield(body: string, title?: string): string {
  try {
    const rawSvg = bytefield(body);
    if (typeof rawSvg !== "string" || !rawSvg.includes("<svg")) {
      return renderFallbackCode(body);
    }
    const svg = rawSvg.replace(/^<\?xml[^?]*\?>\s*/i, "");
    const caption = title
      ? `<div class="title">${encodeHtmlEntities(title)}</div>`
      : "";
    return `<div class="diagram-svg">${caption}${svg}</div>`;
  } catch {
    return renderFallbackCode(body);
  }
}

function createDiagramRegistry() {
  const registry = asciidoctor.Extensions.create();
  const makePass = (
    processor: unknown,
    parent: unknown,
    html: string,
    attrs: Record<string, unknown>,
  ) =>
    (
      processor as {
        createPassBlock(p: unknown, h: string, a: Record<string, unknown>): never;
      }
    ).createPassBlock(parent, html, attrs);

  registry.block("wavedrom", function () {
    this.onContext(["literal", "listing", "open", "pass"]);
    this.process((parent, reader, attrs) => {
      const body = reader.getLines().join("\n");
      const title = typeof attrs?.title === "string" ? attrs.title : undefined;
      return makePass(this, parent, renderWaveDrom(body, title), attrs);
    });
  });
  registry.block("bytefield", function () {
    this.onContext(["literal", "listing", "open", "pass"]);
    this.process((parent, reader, attrs) => {
      const body = reader.getLines().join("\n");
      const title = typeof attrs?.title === "string" ? attrs.title : undefined;
      return makePass(this, parent, renderBytefield(body, title), attrs);
    });
  });
  registry.inlineMacro("cite", function () {
    this.match(/cite:([a-z]*)\[([^\]]*)\]/);
    this.process((parent, target, attrs) => {
      const makeInline = (text: string) =>
        (
          this as unknown as {
            createInline(p: unknown, ctx: string, t: string, o: Record<string, unknown>): never;
          }
        ).createInline(parent, "quoted", text, { type: "unquoted" });
      const mode = String(target || "").trim().toLowerCase();
      const rawPos = Array.isArray((attrs as { $positional?: unknown[] })?.$positional)
        ? ((attrs as { $positional: unknown[] }).$positional as string[])
        : [];
      const keys = rawPos
        .flatMap((part) => String(part).split(","))
        .map((k) => k.trim())
        .filter((k) => k && !/^(?:pages?|pp?)=/i.test(k));
      if (keys.length === 0) {
        return makeInline("");
      }
      const links = keys.map((key) => {
        const safe = encodeHtmlEntities(key);
        const modeAttr = mode ? ` data-cite-mode="${encodeHtmlEntities(mode)}"` : "";
        return `<a class="cite-ref" href="#bib-${safe}" data-cite-key="${safe}"${modeAttr}>${safe}</a>`;
      });
      const inlineHtml =
        mode === "t" || mode === "author" || mode === "year" || mode === "alt"
          ? links.join(", ")
          : `[${links.join(", ")}]`;
      return makeInline(inlineHtml);
    });
  });
  return registry;
}

const SHIKI_LANG_MAP: Record<string, string> = {
  adoc: "asciidoc",
  asciidoc: "asciidoc",
  asm: "riscv",
  bash: "shellscript",
  c: "c",
  "c++": "cpp",
  cc: "cpp",
  console: "shellscript",
  cpp: "cpp",
  cxx: "cpp",
  diff: "diff",
  gas: "riscv",
  h: "c",
  hpp: "cpp",
  json: "json",
  jsonc: "json",
  make: "make",
  makefile: "make",
  mk: "make",
  patch: "diff",
  py: "python",
  python: "python",
  riscv: "riscv",
  "riscv-asm": "riscv",
  rs: "rust",
  rust: "rust",
  s: "riscv",
  sh: "shellscript",
  shell: "shellscript",
  shellscript: "shellscript",
  sv: "system-verilog",
  "system-verilog": "system-verilog",
  systemverilog: "system-verilog",
  toml: "toml",
  v: "verilog",
  verilog: "verilog",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shellscript",
};

const DEFAULT_LIGHT_FG = "#1f2328";
const DEFAULT_DARK_FG = "#e6edf3";

let shikiHighlighter: ReturnType<typeof createHighlighterCoreSync> | null = null;

function getShikiHighlighter() {
  return (shikiHighlighter ??= createHighlighterCoreSync({
    themes: [themeGithubLightDefault, themeGithubDarkDefault],
    langs: [
      langAsciidoc,
      langC,
      langCpp,
      langDiff,
      langJson,
      langMake,
      langPython,
      langRiscv,
      langRust,
      langShellscript,
      langSystemVerilog,
      langToml,
      langVerilog,
      langYaml,
    ],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }));
}

function formatShikiStyle(style: Record<string, string> | undefined): string {
  if (!style) return "";
  const entries = Object.entries(style);
  if (entries.length === 0) return "";
  if (
    entries.length === 2 &&
    style["--shiki-light"]?.toLowerCase() === DEFAULT_LIGHT_FG &&
    style["--shiki-dark"]?.toLowerCase() === DEFAULT_DARK_FG
  ) {
    return "";
  }
  return entries.map(([k, v]) => `${k}:${v}`).join(";");
}

function collectCodeTextNodes(el: ParsedHtmlElement, out: TextNode[]): void {
  for (const child of el.childNodes) {
    if (child.nodeType === NodeType.TEXT_NODE) {
      out.push(child as TextNode);
    } else if (child.nodeType === NodeType.ELEMENT_NODE) {
      const childEl = child as ParsedHtmlElement;
      if (childEl.classList?.contains("conum")) continue;
      collectCodeTextNodes(childEl, out);
    }
  }
}

function highlightCodeElement(codeEl: ParsedHtmlElement, shikiLang: string): void {
  const textNodes: TextNode[] = [];
  collectCodeTextNodes(codeEl, textNodes);
  if (textNodes.length === 0) return;

  const segments = textNodes.map((tn) => decodeHtmlEntities(tn.rawText));
  const fullCode = segments.join("");
  if (!fullCode.trim()) return;

  const { tokens } = getShikiHighlighter().codeToTokens(fullCode, {
    lang: shikiLang,
    themes: {
      light: "github-light-default",
      dark: "github-dark-default",
    },
    defaultColor: false,
  });

  const flatTokens = tokens.flat().filter((t) => t.content.length > 0);
  let tokIdx = 0;
  let segStart = 0;

  for (let i = 0; i < textNodes.length; i++) {
    const segEnd = segStart + segments[i].length;
    let cursor = segStart;
    let html = "";

    while (
      tokIdx < flatTokens.length &&
      flatTokens[tokIdx].offset + flatTokens[tokIdx].content.length <= segStart
    ) {
      tokIdx++;
    }

    for (let k = tokIdx; k < flatTokens.length; k++) {
      const tok = flatTokens[k];
      const tokStart = tok.offset;
      if (tokStart >= segEnd) break;
      const tokEnd = tokStart + tok.content.length;

      if (tokStart > cursor) {
        const gapEnd = Math.min(tokStart, segEnd);
        html += encodeHtmlEntities(fullCode.slice(cursor, gapEnd));
        cursor = gapEnd;
      }

      const sliceStart = Math.max(tokStart, cursor);
      const sliceEnd = Math.min(tokEnd, segEnd);
      if (sliceEnd > sliceStart) {
        const slice = fullCode.slice(sliceStart, sliceEnd);
        const style = slice.trim() ? formatShikiStyle(tok.htmlStyle) : "";
        const escaped = encodeHtmlEntities(slice);
        html += style ? `<span style="${style}">${escaped}</span>` : escaped;
        cursor = sliceEnd;
      }

      if (tokEnd <= segEnd) {
        tokIdx = k + 1;
      }
    }

    if (cursor < segEnd) {
      html += encodeHtmlEntities(fullCode.slice(cursor, segEnd));
    }

    textNodes[i].rawText = html;
    segStart = segEnd;
  }
}

function highlightCodeInHtml(root: ParsedHtmlElement): void {
  const codeEls = root.querySelectorAll("code");
  for (const codeEl of codeEls) {
    if ((codeEl.parentNode as ParsedHtmlElement | null)?.tagName?.toUpperCase() !== "PRE") {
      continue;
    }
    const rawLang = (codeEl.getAttribute("data-lang") ?? "").trim().toLowerCase();
    const shikiLang = SHIKI_LANG_MAP[rawLang];
    if (!shikiLang) continue;
    highlightCodeElement(codeEl, shikiLang);
  }
}

function hasCodeAncestor(node: TextNode): boolean {
  let cur: ParsedHtmlElement | null = node.parentNode as ParsedHtmlElement | null;
  while (cur) {
    const tag = cur.tagName?.toUpperCase();
    if (tag === "PRE" || tag === "CODE") {
      return true;
    }
    cur = cur.parentNode as ParsedHtmlElement | null;
  }
  return false;
}

function postProcessHtml(html: string): string {
  const root = parse(html, {
    blockTextElements: {
      script: true,
      noscript: true,
      style: true,
    },
  });
  highlightCodeInHtml(root);
  const stack: Array<ParsedHtmlElement | TextNode> = [...root.childNodes] as Array<
    ParsedHtmlElement | TextNode
  >;
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.nodeType === NodeType.TEXT_NODE) {
      const textNode = node as TextNode;
      if (hasCodeAncestor(textNode)) continue;
      const raw = textNode.rawText;
      if (!raw.includes("\\[") && !raw.includes("\\(")) continue;
      let replaced = raw.replace(/\\\[([\s\S]*?)\\\]/g, (_m, expr: string) =>
        katex.renderToString(decodeHtmlEntities(expr.trim()), {
          displayMode: true,
          throwOnError: false,
        }),
      );
      replaced = replaced.replace(/\\\(([\s\S]*?)\\\)/g, (_m, expr: string) =>
        katex.renderToString(decodeHtmlEntities(expr.trim()), {
          displayMode: false,
          throwOnError: false,
        }),
      );
      if (replaced !== raw) {
        textNode.rawText = replaced;
      }
    } else if (node.nodeType === NodeType.ELEMENT_NODE) {
      const el = node as ParsedHtmlElement;
      for (let i = el.childNodes.length - 1; i >= 0; i--) {
        stack.push(el.childNodes[i] as ParsedHtmlElement | TextNode);
      }
    }
  }
  return root.toString();
}

const lowerSymbolCache = new WeakMap<
  ReadonlyMap<string, XrefTargetInfo>,
  Map<string, XrefTargetInfo>
>();

function getLowerSymbolMap(
  symbols: ReadonlyMap<string, XrefTargetInfo>,
): Map<string, XrefTargetInfo> {
  let cached = lowerSymbolCache.get(symbols);
  if (!cached) {
    cached = new Map();
    for (const [k, v] of symbols) {
      const lower = k.toLowerCase();
      if (!cached.has(lower)) {
        cached.set(lower, v);
      }
    }
    lowerSymbolCache.set(symbols, cached);
  }
  return cached;
}

function lookupXrefSymbol(
  candidates: string[],
  symbols: ReadonlyMap<string, XrefTargetInfo>,
  symbolsLower: ReadonlyMap<string, XrefTargetInfo>,
): XrefTargetInfo | undefined {
  for (const cand of candidates) {
    if (!cand) continue;
    const exact = symbols.get(cand);
    if (exact) return exact;
  }
  for (const cand of candidates) {
    if (!cand) continue;
    const lower = symbolsLower.get(cand.toLowerCase());
    if (lower) return lower;
  }
  return undefined;
}

function formatXrefLabel(
  info: XrefTargetInfo,
  lang: "en" | "zh",
  fallbackId: string,
): string {
  const title = (lang === "zh" ? info.title_zh || info.title_en : info.title_en)?.trim() ?? "";

  if (info.kind === "section" || info.kind === "heading") {
    const isAppendix =
      info.sectname === "appendix" ||
      (info.sectnum !== null && /^[A-Z](?:\.|$)/.test(info.sectnum));
    if (info.sectnum) {
      if (isAppendix) {
        return lang === "zh"
          ? `附录 ${info.sectnum}${title ? `“${title}”` : ""}`
          : `Appendix ${info.sectnum}${title ? ` "${title}"` : ""}`;
      }
      if (!info.sectnum.includes(".")) {
        return lang === "zh"
          ? `第 ${info.sectnum} 章${title ? `“${title}”` : ""}`
          : `Chapter ${info.sectnum}${title ? ` "${title}"` : ""}`;
      }
      return lang === "zh"
        ? `第 ${info.sectnum} 节${title ? `“${title}”` : ""}`
        : `Section ${info.sectnum}${title ? ` "${title}"` : ""}`;
    }
    if (title) return title;
  }

  if (title) return title;
  if (info.sectnum) {
    return lang === "zh" ? `第 ${info.sectnum} 节` : `Section ${info.sectnum}`;
  }
  return fallbackId;
}

/**
 * Compile-time cross-reference rewriter run per snapshot during `build-site`:
 * - Resolves `data-rv-extlink` & `data-rv-insnlink` macros against the snapshot symbol table
 *   (and unwraps missing ones so dead `#` / relative links never leak).
 * - Resolves AsciiDoc's fallback `<a href="#id">[id]</a>` cross-references into localized
 *   chapter/section/table labels (or marks bibliography citations with `.cite-ref`).
 */
export function rewriteHtmlXrefs(
  html: string,
  lang: "en" | "zh",
  symbols: ReadonlyMap<string, XrefTargetInfo>,
): string {
  if (!html || !html.includes("<a")) {
    return html;
  }

  const symbolsLower = getLowerSymbolMap(symbols);
  const root = parse(html, {
    blockTextElements: {
      script: true,
      noscript: true,
      style: true,
    },
  });

  let mutated = false;
  const links = root.querySelectorAll("a");

  for (const a of links) {
    const extTarget = a.getAttribute("data-rv-extlink");
    if (extTarget !== undefined) {
      mutated = true;
      const raw = decodeHtmlEntities(extTarget).trim();
      const lower = raw.toLowerCase();
      const slug = lower.replace(/[^a-z0-9]+/g, "_");
      const info = lookupXrefSymbol(
        [
          raw,
          lower,
          formatRiscvExtensionName(raw),
          `chap:${lower}`,
          `sec:${lower}`,
          `${lower}-ext`,
          `_${slug}`,
        ],
        symbols,
        symbolsLower,
      );
      a.removeAttribute("data-rv-extlink");
      if (info) {
        a.setAttribute("href", `#${info.anchor_id}`);
        a.setAttribute("class", "rv-extlink xref-resolved");
      } else {
        a.replaceWith(`<span class="rv-ext">${a.innerHTML}</span>`);
      }
      continue;
    }

    const insnTarget = a.getAttribute("data-rv-insnlink");
    if (insnTarget !== undefined) {
      mutated = true;
      const raw = decodeHtmlEntities(insnTarget).trim();
      const lower = raw.toLowerCase();
      const dashSlug = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const underSlug = lower.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      const info = lookupXrefSymbol(
        [
          `insns-${dashSlug}`,
          `insns-${lower}`,
          `norm:${dashSlug}`,
          `norm:${underSlug}`,
          dashSlug,
          underSlug,
          lower,
          raw,
        ],
        symbols,
        symbolsLower,
      );
      a.removeAttribute("data-rv-insnlink");
      if (info) {
        a.setAttribute("href", `#${info.anchor_id}`);
        a.setAttribute("class", "rv-insnlink xref-resolved");
      } else {
        a.replaceWith(a.innerHTML);
      }
      continue;
    }

    const href = a.getAttribute("href") ?? "";
    if (!href.startsWith("#") || href.startsWith("#_footnot")) {
      continue;
    }

    const targetId = decodeHtmlEntities(href.slice(1));
    const innerText = decodeHtmlEntities(a.textContent).trim();
    if (!targetId || innerText !== `[${targetId}]`) {
      continue;
    }

    const info = lookupXrefSymbol([targetId, targetId.toLowerCase()], symbols, symbolsLower);
    if (!info) continue;

    mutated = true;
    a.setAttribute("href", `#${info.anchor_id}`);

    const existingClass = (a.getAttribute("class") ?? "").trim();
    if (info.is_bibliography || (info.kind === "list" && !info.title_en && !info.title_zh)) {
      a.setAttribute("class", existingClass ? `${existingClass} cite-ref` : "cite-ref");
      continue;
    }

    const label = formatXrefLabel(info, lang, targetId);
    a.setAttribute("class", existingClass ? `${existingClass} xref-resolved` : "xref-resolved");
    a.set_content(escapeHtmlText(label));
  }

  return mutated ? root.toString() : html;
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Convert an AsciiDoc unit (EN or ZH) into a clean HTML fragment without `<html>` wrapper.
 */
export function renderAdocFragment(adoc: string, kind: BlockKind): string {
  const trimmed = adoc.replace(/\r\n?/g, "\n").trim();
  if (!trimmed) {
    return "";
  }

  if (kind === "diagram" && trimmed.startsWith("{")) {
    return renderWaveDrom(trimmed);
  }

  let prepared = expandRiscvMacrosForHtml(trimmed);
  if (kind === "heading") {
    const lines = prepared.split("\n");
    const lastIdx = lines.length - 1;
    if (!/^=+\s+/.test(lines[lastIdx].trim())) {
      lines[lastIdx] = `== ${lines[lastIdx].trim()}`;
      prepared = lines.join("\n");
    }
  }

  const needsDiagramRegistry =
    kind === "diagram" ||
    trimmed.includes("wavedrom") ||
    trimmed.includes("bytefield") ||
    trimmed.includes("cite:");

  const html = String(
    asciidoctor.convert(prepared, {
      safe: "secure",
      ...(needsDiagramRegistry
        ? { extension_registry: createDiagramRegistry() }
        : {}),
      attributes: {
        stem: "latexmath",
        showtitle: "",
      },
    }),
  ).trim();

  if (kind === "heading") {
    const root = parse(html);
    const heading = root.querySelector("h1, h2, h3, h4, h5, h6");
    if (heading) {
      return postProcessHtml(heading.outerHTML);
    }
  }

  return postProcessHtml(html);
}
