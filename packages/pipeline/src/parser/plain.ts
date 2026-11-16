import { decode as decodeHtmlEntities } from "he";
import {
  NodeType,
  parse,
  type HTMLElement as ParsedHtmlElement,
  type Node as ParsedNode,
  type TextNode,
} from "node-html-parser";
import type { BlockKind } from "@riscv-cn/schema";
import { expandRiscvMacrosPlain } from "./macros.ts";

export interface PlainTextOptions {
  /** Map of cross-reference anchor IDs to resolved section/chapter titles. */
  xrefTitles?: ReadonlyMap<string, string>;
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "IMG"]);

const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "UL",
]);

const CODE_SYMBOL_STOPWORDS = new Set([
  "if",
  "for",
  "while",
  "return",
  "struct",
  "const",
  "unsigned",
  "signed",
  "void",
  "char",
  "int",
  "long",
  "see",
  "the",
  "and",
]);

const LATEX_OPERATOR_MAP: Array<[RegExp, string]> = [
  [/\\leftrightarrow(?![A-Za-z])/g, "↔"],
  [/\\Rightarrow(?![A-Za-z])/g, "⇒"],
  [/\\rightarrow(?![A-Za-z])/g, "→"],
  [/\\leftarrow(?![A-Za-z])/g, "←"],
  [/\\to(?![A-Za-z])/g, "→"],
  [/\\approx(?![A-Za-z])/g, "≈"],
  [/\\equiv(?![A-Za-z])/g, "≡"],
  [/\\infty(?![A-Za-z])/g, "∞"],
  [/\\times(?![A-Za-z])/g, "×"],
  [/\\cdot(?![A-Za-z])/g, "·"],
  [/\\oplus(?![A-Za-z])/g, "⊕"],
  [/\\wedge(?![A-Za-z])/g, "∧"],
  [/\\land(?![A-Za-z])/g, "∧"],
  [/\\vee(?![A-Za-z])/g, "∨"],
  [/\\lor(?![A-Za-z])/g, "∨"],
  [/\\lnot(?![A-Za-z])/g, "¬"],
  [/\\neg(?![A-Za-z])/g, "¬"],
  [/\\lfloor(?![A-Za-z])/g, "⌊"],
  [/\\rfloor(?![A-Za-z])/g, "⌋"],
  [/\\lceil(?![A-Za-z])/g, "⌈"],
  [/\\rceil(?![A-Za-z])/g, "⌉"],
  [/\\leq(?![A-Za-z])/g, "≤"],
  [/\\le(?![A-Za-z])/g, "≤"],
  [/\\geq(?![A-Za-z])/g, "≥"],
  [/\\ge(?![A-Za-z])/g, "≥"],
  [/\\neq(?![A-Za-z])/g, "≠"],
  [/\\ne(?![A-Za-z])/g, "≠"],
  [/\\pm(?![A-Za-z])/g, "±"],
  [/\\ll(?![A-Za-z])/g, "<<"],
  [/\\gg(?![A-Za-z])/g, ">>"],
];

const LBRACE_SENTINEL = "\uE000";
const RBRACE_SENTINEL = "\uE001";
const UNDERSCORE_SENTINEL = "\uE002";

function cleanLatexForPlainText(tex: string): string {
  let s = tex
    .replace(/\\\{/g, LBRACE_SENTINEL)
    .replace(/\\\}/g, RBRACE_SENTINEL)
    .replace(/\\_/g, UNDERSCORE_SENTINEL)
    .replace(
      /\\(?:displaystyle|textstyle|scriptstyle|scriptscriptstyle|left|right)(?:\.(?=\s|$)|(?![A-Za-z]))/g,
      "",
    )
    .replace(/\\[,!]/g, "")
    .replace(/\\(?:quad|qquad|[;:])/g, " ");

  for (let i = 0; i < 4; i++) {
    const next = s.replace(
      /\\(?:text|mathrm|mathit|mathbf|mathsf|mathtt|operatorname)\{([^{}]*)\}/g,
      "$1",
    );
    if (next === s) break;
    s = next;
  }

  for (let i = 0; i < 2; i++) {
    const next = s.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, (_m, a: string, b: string) => {
      const num = a.trim();
      const den = b.trim();
      const simpleNum = /^[A-Za-z0-9]+$/.test(num);
      const simpleDen = /^[A-Za-z0-9]+$/.test(den);
      return simpleNum && simpleDen ? `${num}/${den}` : `(${num})/(${den})`;
    });
    if (next === s) break;
    s = next;
  }

  for (const [pattern, replacement] of LATEX_OPERATOR_MAP) {
    s = s.replace(pattern, replacement);
  }

  s = s
    .replace(/\^\{([A-Za-z0-9+-]+)\}/g, "^$1")
    .replace(/_\{([A-Za-z0-9+-]+)\}/g, "_$1");

  for (let i = 0; i < 2; i++) {
    const next = s.replace(/(?<![_\^])\{([^{}]*)\}/g, "$1");
    if (next === s) break;
    s = next;
  }

  return s
    .replaceAll(LBRACE_SENTINEL, "{")
    .replaceAll(RBRACE_SENTINEL, "}")
    .replaceAll(UNDERSCORE_SENTINEL, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function stripSyntheticTitlePrefix(text: string): string {
  return text.replace(/^(?:Table|Figure|Example|Listing)\s+\d+\.\s*/i, "").trim();
}

function fallbackXrefLabel(targetId: string): string {
  return targetId.replace(/^(?:insns-|norm:|sec:|ch:|fig:|tab:|tbl:)/i, "");
}

function finalizePlainText(raw: string): string {
  return expandRiscvMacrosPlain(raw)
    .replace(/\bindexterm2?:\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

class PlainTextCollector {
  private chunks: string[] = [];

  constructor(private readonly options?: PlainTextOptions) {}

  ensureSpace(): void {
    if (this.chunks.length === 0) return;
    const last = this.chunks[this.chunks.length - 1];
    if (last && !/\s$/.test(last)) {
      this.chunks.push(" ");
    }
  }

  appendRaw(text: string): void {
    if (!text) return;
    this.chunks.push(text);
  }

  build(): string {
    return this.chunks.join("").replace(/\s+/g, " ").trim();
  }

  private subCollect(nodes: ParsedNode[]): string {
    const nested = new PlainTextCollector(this.options);
    for (const n of nodes) {
      nested.visit(n);
    }
    return nested.build();
  }

  visitChildren(el: ParsedHtmlElement): void {
    for (const child of el.childNodes) {
      this.visit(child);
    }
  }

  visit(node: ParsedNode): void {
    if (node.nodeType === NodeType.TEXT_NODE) {
      this.appendRaw(decodeHtmlEntities((node as TextNode).rawText));
      return;
    }
    if (node.nodeType !== NodeType.ELEMENT_NODE) {
      return;
    }

    const el = node as ParsedHtmlElement;
    const tag = el.tagName?.toUpperCase() ?? "";

    if (SKIP_TAGS.has(tag)) {
      return;
    }

    if (tag === "PRE" && el.classList?.contains("diagram-fallback")) {
      return;
    }

    if (el.classList?.contains("conum")) {
      return;
    }

    if (
      tag === "SUP" &&
      (el.classList?.contains("footnote") || el.classList?.contains("footnoteref"))
    ) {
      return;
    }

    if (tag === "BR" || tag === "HR") {
      this.ensureSpace();
      return;
    }

    if (el.classList?.contains("katex")) {
      const annotation =
        el.querySelector('annotation[encoding="application/x-tex"]') ??
        el.querySelector("annotation");
      if (annotation) {
        const cleaned = cleanLatexForPlainText(decodeHtmlEntities(annotation.rawText));
        if (cleaned) {
          this.appendRaw(cleaned);
        }
        return;
      }
    }

    if (el.classList?.contains("admonitionblock")) {
      this.ensureSpace();
      const content = el.querySelector(".content");
      if (content) {
        this.visitChildren(content);
      } else {
        for (const child of el.childNodes) {
          if (
            child.nodeType === NodeType.ELEMENT_NODE &&
            (child as ParsedHtmlElement).classList?.contains("icon")
          ) {
            continue;
          }
          this.visit(child);
        }
      }
      this.ensureSpace();
      return;
    }

    if (el.classList?.contains("icon") && el.closest?.(".admonitionblock")) {
      return;
    }

    if (el.classList?.contains("colist")) {
      this.ensureSpace();
      this.visitChildren(el);
      this.ensureSpace();
      return;
    }

    if (el.classList?.contains("title") || tag === "CAPTION") {
      this.ensureSpace();
      const stripped = stripSyntheticTitlePrefix(this.subCollect(el.childNodes));
      if (stripped) {
        this.appendRaw(stripped);
      }
      this.ensureSpace();
      return;
    }

    if (tag === "TABLE") {
      this.ensureSpace();
      const captionEl = el.querySelector("caption");
      const caption = captionEl
        ? stripSyntheticTitlePrefix(this.subCollect(captionEl.childNodes))
        : "";
      const rowsText: string[] = [];
      for (const tr of el.querySelectorAll("tr")) {
        const cells: string[] = [];
        for (const child of tr.childNodes) {
          if (child.nodeType !== NodeType.ELEMENT_NODE) continue;
          const cellEl = child as ParsedHtmlElement;
          const cellTag = cellEl.tagName?.toUpperCase();
          if (cellTag !== "TH" && cellTag !== "TD") continue;
          const cellText = this.subCollect(cellEl.childNodes);
          if (cellText) {
            cells.push(cellText);
          }
        }
        if (cells.length > 0) {
          rowsText.push(cells.join(" · "));
        }
      }
      const parts: string[] = [];
      if (caption) parts.push(caption);
      parts.push(...rowsText);
      if (parts.length > 0) {
        this.appendRaw(parts.join(" — "));
      }
      this.ensureSpace();
      return;
    }

    if (tag === "DL") {
      this.ensureSpace();
      for (const child of el.childNodes) {
        if (child.nodeType !== NodeType.ELEMENT_NODE) continue;
        const childEl = child as ParsedHtmlElement;
        const childTag = childEl.tagName?.toUpperCase();
        if (childTag === "DT") {
          this.ensureSpace();
          const term = this.subCollect(childEl.childNodes).replace(/:+$/, "").trim();
          if (term) {
            this.appendRaw(`${term}: `);
          }
        } else if (childTag === "DD") {
          const def = this.subCollect(childEl.childNodes);
          if (def) {
            this.appendRaw(def);
            this.ensureSpace();
          }
        } else {
          this.visit(childEl);
        }
      }
      this.ensureSpace();
      return;
    }

    if (el.id === "footnotes") {
      const fnNodes = el.querySelectorAll(".footnote");
      for (const fn of fnNodes) {
        const nested = new PlainTextCollector(this.options);
        for (const child of fn.childNodes) {
          if (child.nodeType === NodeType.ELEMENT_NODE) {
            const childEl = child as ParsedHtmlElement;
            const childTag = childEl.tagName?.toUpperCase();
            const childHref = childEl.getAttribute?.("href") ?? "";
            if (childTag === "A" && childHref.startsWith("#_footnoteref_")) {
              continue;
            }
          }
          nested.visit(child);
        }
        const cleaned = nested.build().replace(/^\s*\.\s*/, "").trim();
        if (cleaned) {
          this.ensureSpace();
          this.appendRaw(cleaned);
          this.ensureSpace();
        }
      }
      return;
    }

    if (tag === "A") {
      const href = el.getAttribute("href") ?? "";
      if (href.startsWith("#_footnoteref_")) {
        return;
      }
      const inner = this.subCollect(el.childNodes);
      if (href.startsWith("#") && !href.startsWith("#_footnote")) {
        const targetId = href.slice(1);
        if (inner.trim() === `[${targetId}]`) {
          const resolved = this.options?.xrefTitles?.get(targetId)?.trim();
          this.appendRaw(resolved || fallbackXrefLabel(targetId));
          return;
        }
      }
      this.appendRaw(inner);
      return;
    }

    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) this.ensureSpace();
    this.visitChildren(el);
    if (isBlock) this.ensureSpace();
  }
}

/**
 * Convert a rendered HTML fragment (produced by `renderAdocFragment`) into clean searchable
 * plain text, removing markup, KaTeX DOM duplication, admonition icons, and diagram fallbacks.
 */
export function htmlToPlainText(
  html: string,
  _kind: BlockKind,
  options?: PlainTextOptions,
): string {
  if (!html.trim()) return "";
  const root = parse(html, {
    blockTextElements: {
      script: true,
      noscript: true,
      style: true,
    },
  });
  const collector = new PlainTextCollector(options);
  for (const child of root.childNodes) {
    collector.visit(child);
  }
  return finalizePlainText(collector.build());
}

/**
 * Extract deduplicated inline `<code>` identifiers (mnemonics, CSRs, registers, extensions)
 * from a rendered HTML fragment, ignoring block `<pre><code>` listings.
 */
export function extractCodeSymbols(html: string): string[] {
  if (!html.trim()) return [];
  const root = parse(html, {
    blockTextElements: {
      script: true,
      noscript: true,
      style: true,
    },
  });

  const symbols: string[] = [];
  const seenLower = new Set<string>();

  for (const codeEl of root.querySelectorAll("code")) {
    const parent = codeEl.parentNode as ParsedHtmlElement | null;
    if (parent?.tagName?.toUpperCase() === "PRE") {
      continue;
    }

    const raw = decodeHtmlEntities(codeEl.textContent).replace(/\s+/g, " ").trim();
    if (!raw) continue;

    let candidate: string | null = null;
    if (/^[A-Za-z_][A-Za-z0-9_.:-]{0,39}$/.test(raw)) {
      candidate = raw;
    } else if (raw.length <= 64) {
      const m = /^([A-Za-z][A-Za-z0-9_.]{1,31})\s+[A-Za-z0-9_(),\s+-]+$/.exec(raw);
      if (m && !CODE_SYMBOL_STOPWORDS.has(m[1].toLowerCase())) {
        candidate = m[1];
      }
    }

    if (!candidate) continue;
    const lower = candidate.toLowerCase();
    if (seenLower.has(lower)) continue;
    seenLower.add(lower);
    symbols.push(candidate);
    if (symbols.length >= 24) break;
  }

  return symbols;
}
