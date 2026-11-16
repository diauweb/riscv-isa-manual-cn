import MiniSearch from "minisearch";
import type { SearchEntry } from "../types";

interface SearchDoc {
  id: number;
  heading_text: string;
  symbols: string;
  anchors: string;
  section_title: string;
  chapter_title: string;
  zh: string;
  en: string;
}

interface IndexedEntryMeta {
  en: string;
  zh: string;
  anchorsLower: string[];
  symbolsLower: string[];
}

export interface SearchIndexState {
  entries: SearchEntry[];
  meta: IndexedEntryMeta[];
  mini: MiniSearch<SearchDoc>;
}

const wordSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("zh", { granularity: "word" })
    : null;

/**
 * Segment user search input into lowercase tokens, preserving compound identifiers
 * like `czero.eqz` or `norm:addi_op` as single query terms while segmenting CJK text.
 */
export function tokenizeQuery(text: string): string[] {
  const cleaned = text.trim();
  if (!cleaned) return [];
  if (!wordSegmenter) {
    return (cleaned.toLowerCase().match(/[\p{L}\p{N}]+(?:[.:_][\p{L}\p{N}]+)*/gu) ?? []).filter(
      Boolean,
    );
  }
  const tokens: string[] = [];
  for (const seg of wordSegmenter.segment(cleaned)) {
    if (seg.isWordLike) {
      tokens.push(seg.segment.toLowerCase());
    }
  }
  return tokens;
}

/**
 * Index-time tokenizer that keeps compound identifiers intact and additionally
 * emits component sub-tokens split on `.`, `:`, and `_`.
 */
export function tokenizeIndex(text: string): string[] {
  const base = tokenizeQuery(text);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (tok: string) => {
    if (!tok || seen.has(tok)) return;
    seen.add(tok);
    out.push(tok);
  };

  for (const tok of base) {
    add(tok);
    if (tok.includes(":")) {
      for (const part of tok.split(":")) {
        add(part);
      }
    }
    if (/[.:_]/.test(tok)) {
      for (const part of tok.split(/[.:_]+/)) {
        add(part);
      }
    }
  }
  return out;
}

/** Build an in-memory MiniSearch index and normalized entry metadata table. */
export function buildSearchIndex(entries: SearchEntry[]): SearchIndexState {
  const mini = new MiniSearch<SearchDoc>({
    fields: [
      "heading_text",
      "symbols",
      "anchors",
      "section_title",
      "chapter_title",
      "zh",
      "en",
    ],
    tokenize: tokenizeIndex,
    searchOptions: {
      tokenize: tokenizeQuery,
      prefix: true,
      fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
      combineWith: "AND",
      boost: {
        heading_text: 5,
        symbols: 4,
        anchors: 3.5,
        section_title: 2.5,
        chapter_title: 2,
        zh: 1.5,
        en: 1.2,
      },
    },
  });

  const meta: IndexedEntryMeta[] = new Array(entries.length);
  const docs: SearchDoc[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const enClean = entry.en.trim();
    const zhClean = (entry.zh ?? "").trim();
    const anchorsList = [entry.anchor_id, ...(entry.extra_anchors ?? [])].filter(
      (a): a is string => Boolean(a),
    );
    const symbolsList = entry.symbols ?? [];

    meta[i] = {
      en: enClean,
      zh: zhClean,
      anchorsLower: anchorsList.map((a) => a.toLowerCase()),
      symbolsLower: symbolsList.map((s) => s.toLowerCase()),
    };

    if (!enClean && !zhClean && anchorsList.length === 0 && symbolsList.length === 0) {
      continue;
    }

    const headingText =
      entry.kind === "heading" ? [zhClean, enClean].filter(Boolean).join(" ") : "";

    docs.push({
      id: i,
      heading_text: headingText,
      symbols: symbolsList.join(" "),
      anchors: anchorsList.join(" "),
      section_title: [entry.section_title_zh, entry.section_title].filter(Boolean).join(" "),
      chapter_title: [entry.chapter_title_zh, entry.chapter_title].filter(Boolean).join(" "),
      zh: zhClean,
      en: enClean,
    });
  }

  mini.addAll(docs);
  return { entries, meta, mini };
}

/** Search the index and apply structural ranking boosts for headings, symbols, and anchors. */
export function runSearch(
  state: SearchIndexState,
  rawQuery: string,
  limit = 50,
): SearchEntry[] {
  const normalized = rawQuery.trim().replace(/^#+/, "");
  if (!normalized) return [];

  const qLower = normalized.toLowerCase();
  const qTokens = tokenizeQuery(normalized);
  const hits = state.mini.search(normalized);

  const rescored = hits.map((hit) => {
    const id = hit.id as number;
    const entry = state.entries[id];
    const entryMeta = state.meta[id];
    let score = hit.score;

    if (entry.kind === "code") {
      score *= 0.65;
    } else if (entry.kind === "diagram" && !entryMeta.en && !entryMeta.zh) {
      score *= 0.5;
    }

    const anchorExact = entryMeta.anchorsLower.some(
      (a) => a === qLower || a === `insns-${qLower}` || a === `norm:${qLower}`,
    );
    const anchorPrefix =
      !anchorExact &&
      entryMeta.anchorsLower.some(
        (a) =>
          a.startsWith(`norm:${qLower}_`) ||
          a.startsWith(`insns-${qLower}-`) ||
          a.startsWith(`insns-${qLower}_`),
      );
    if (anchorExact) {
      score *= 3.0;
    } else if (anchorPrefix) {
      score *= 1.8;
    }

    if (entry.kind === "heading") {
      if (
        entryMeta.en.toLowerCase() === qLower ||
        entryMeta.zh.toLowerCase() === qLower
      ) {
        score *= 3.0;
      } else {
        score *= 1.35;
      }
    }

    if (qTokens.length === 1 && entryMeta.symbolsLower.includes(qLower)) {
      score *= 1.6;
      const enLower = entryMeta.en.toLowerCase();
      if (enLower.startsWith(`${qLower} `) || enLower.startsWith(`${qLower}(`)) {
        score *= 1.35;
      }
    }

    return { id, score };
  });

  rescored.sort((a, b) => b.score - a.score || a.id - b.id);
  return rescored.slice(0, limit).map((item) => state.entries[item.id]);
}

/** Resolve the route `at` target for a picked search entry. */
export function searchEntryAt(entry: SearchEntry): string | undefined {
  if (entry.kind === "heading") {
    if (
      entry.section_id === entry.chapter_id ||
      (!entry.section_title && !entry.section_title_zh)
    ) {
      return undefined;
    }
    return entry.section_id || entry.anchor_id || `u-${entry.unit_id.slice(0, 12)}`;
  }
  return entry.anchor_id || `u-${entry.unit_id.slice(0, 12)}`;
}
