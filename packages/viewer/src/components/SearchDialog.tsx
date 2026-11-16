import React, { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Search, X } from "lucide-react";
import type { SearchEntry } from "../types";
import type { ReadingLang } from "../lib/settings";
import {
  buildSearchIndex,
  runSearch,
  tokenizeQuery,
  type SearchIndexState,
} from "../lib/search";
import { useBodyScrollLock } from "../lib/scroll";
import { fetchSearchIndex } from "../utils/dataClient";
import { cx } from "./ui";

interface SearchDialogProps {
  open: boolean;
  demoMode: boolean;
  lang?: ReadingLang;
  onClose: () => void;
  onPick: (entry: SearchEntry) => void;
}

function resolveHighlightTerms(clean: string, terms: string[]): string[] {
  if (terms.length === 0) return [];
  const lower = clean.toLowerCase();
  const sorted = [...new Set(terms)].sort((a, b) => b.length - a.length);
  if (sorted.some((t) => lower.includes(t))) {
    return sorted;
  }
  const subParts: string[] = [];
  for (const t of sorted) {
    if (/[.:_]/.test(t)) {
      for (const part of t.split(/[.:_]+/)) {
        if (part.length >= 2) subParts.push(part);
      }
    }
  }
  if (subParts.length === 0) return [];
  return [...new Set(subParts)].sort((a, b) => b.length - a.length);
}

/** Excerpt around the first matching term, with matches highlighted. */
function Excerpt({ text, terms, max = 140 }: { text: string; terms: string[]; max?: number }) {
  const clean = text.trim();
  const highlightTerms = resolveHighlightTerms(clean, terms);
  const lower = clean.toLowerCase();
  let first = -1;
  for (const t of highlightTerms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  const start = first > 40 ? first - 40 : 0;
  let slice = clean.slice(start, start + max);
  if (start > 0) slice = `…${slice}`;
  if (start + max < clean.length) slice = `${slice}…`;
  if (highlightTerms.length === 0) return <>{slice}</>;
  const re = new RegExp(
    `(${highlightTerms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  return (
    <>
      {slice.split(re).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-[rgba(232,162,0,0.28)] px-px text-inherit">
            {part}
          </mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

function pickDisplayAnchor(entry: SearchEntry, queryLower: string): string | undefined {
  if (entry.anchor_id) return entry.anchor_id;
  if (!entry.extra_anchors?.length || !queryLower) return undefined;
  return entry.extra_anchors.find((a) => {
    const lower = a.toLowerCase();
    return (
      lower.includes(queryLower) ||
      queryLower.split(/[.:_\s]+/).some((t) => t.length > 0 && lower.includes(t))
    );
  });
}

export const SearchDialog: React.FC<SearchDialogProps> = ({
  open,
  demoMode,
  lang = "zh",
  onClose,
  onPick,
}) => {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<SearchIndexState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [vvHeight, setVvHeight] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useBodyScrollLock(open);

  useEffect(() => {
    if (!open) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => setVvHeight(vv.height);
    sync();
    vv.addEventListener("resize", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      setVvHeight(null);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    if (index) return;
    let cancelled = false;
    fetchSearchIndex(demoMode)
      .then((entries) => {
        if (!cancelled) setIndex(buildSearchIndex(entries));
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [open, demoMode, index]);

  const terms = useMemo(() => tokenizeQuery(query), [query]);
  const normalizedQueryLower = useMemo(
    () => query.trim().replace(/^#+/, "").toLowerCase(),
    [query],
  );

  const results = useMemo(() => {
    if (!index || !query.trim()) return [];
    return runSearch(index, query, 50);
  }, [index, query]);

  useEffect(() => setSel(0), [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  const pick = (e: SearchEntry) => {
    onPick(e);
    onClose();
  };

  const showBody = Boolean(error || terms.length > 0);

  return (
    <div
      className="fade-in fixed inset-0 z-[60] flex items-start justify-center bg-black/30 px-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur-[2px] sm:px-3 sm:pt-[12vh]"
      onPointerDown={onClose}
    >
      <div
        style={vvHeight ? { maxHeight: `${Math.max(220, vvHeight - 20)}px` } : undefined}
        className="pop-in flex max-h-[calc(100dvh-1rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--bg-elevated)] shadow-[var(--shadow-pop)] sm:max-h-[70dvh]"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((i) => Math.min(results.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && results[sel]) {
            e.preventDefault();
            pick(results[sel]);
          }
        }}
      >
        <div
          className={cx(
            "flex items-center gap-2.5 px-3.5 sm:gap-3 sm:px-4",
            showBody && "border-b border-[var(--line)]",
          )}
        >
          <Search className="h-4.5 w-4.5 shrink-0 text-[var(--fg-faint)]" />
          <input
            ref={inputRef}
            type="search"
            enterKeyHint="search"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索章节、指令、CSR 或正文…"
            className="h-12 min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-[var(--fg-faint)] sm:h-13 sm:text-[15px]"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label="清空输入"
              className="cursor-pointer rounded-md p-1.5 text-[var(--fg-faint)] hover:bg-[var(--bg-subtle)] active:bg-[var(--bg-subtle)]"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 cursor-pointer rounded-md px-2 py-1 text-[13.5px] font-medium text-[var(--fg-muted)] active:bg-[var(--bg-subtle)] sm:hidden"
          >
            取消
          </button>
          {!query && (
            <button
              type="button"
              onClick={onClose}
              className="hidden cursor-pointer rounded-md p-1.5 text-[var(--fg-faint)] hover:bg-[var(--bg-subtle)] sm:inline-flex"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {showBody && (
          <div ref={listRef} className="scroll-quiet min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 sm:p-2">
            {error ? (
              <p className="p-6 text-center text-sm text-[var(--del-line)]">{error}</p>
            ) : !index ? (
              <p className="p-6 text-center text-sm text-[var(--fg-faint)]">正在加载索引…</p>
            ) : results.length === 0 ? (
              <p className="p-6 text-center text-sm text-[var(--fg-faint)]">无匹配结果</p>
            ) : (
              results.map((r, i) => {
                const chapterLabel =
                  lang === "en" ? r.chapter_title : r.chapter_title_zh || r.chapter_title;
                const sectionLabel =
                  lang === "en" ? r.section_title : r.section_title_zh || r.section_title;
                const showSection =
                  Boolean(sectionLabel) &&
                  sectionLabel !== chapterLabel &&
                  r.kind !== "heading";
                const displayAnchor = pickDisplayAnchor(r, normalizedQueryLower);
                const zhClean = (r.zh ?? "").trim();
                const enClean = r.en.trim();
                const fallbackTitle =
                  sectionLabel || chapterLabel || (displayAnchor ? `#${displayAnchor}` : "");
                const primaryText =
                  lang === "en"
                    ? enClean || zhClean || fallbackTitle
                    : zhClean || enClean || fallbackTitle;
                const primaryLang =
                  lang === "en"
                    ? enClean
                      ? "en"
                      : "zh-CN"
                    : zhClean
                      ? "zh-CN"
                      : "en";
                const secondaryRaw = lang === "en" ? zhClean : enClean;
                const secondaryText =
                  zhClean && enClean && zhClean !== enClean ? secondaryRaw : "";
                const secondaryLang = lang === "en" ? "zh-CN" : "en";

                return (
                  <button
                    key={`${r.chapter_id}:${r.unit_id}:${i}`}
                    type="button"
                    data-idx={i}
                    onPointerMove={(e) => {
                      if (e.pointerType === "mouse") setSel(i);
                    }}
                    onClick={() => pick(r)}
                    className={cx(
                      "block w-full cursor-pointer rounded-xl px-3 py-2.5 text-left transition-colors active:bg-[var(--accent-soft)] sm:px-3.5",
                      i === sel ? "bg-[var(--accent-soft)]" : "",
                    )}
                  >
                    <div className="flex items-center gap-2 text-[12px] text-[var(--fg-faint)]">
                      <span className="truncate">
                        {chapterLabel}
                        {showSection ? ` › ${sectionLabel}` : ""}
                      </span>
                      {displayAnchor && (
                        <span className="shrink-0 truncate font-mono">#{displayAnchor}</span>
                      )}
                      {i === sel && (
                        <CornerDownLeft className="ml-auto hidden h-3.5 w-3.5 shrink-0 sm:block" />
                      )}
                    </div>
                    <div
                      lang={primaryLang}
                      className={cx(
                        "mt-0.5 text-[14px] leading-relaxed text-[var(--fg)]",
                        r.kind === "heading" && "font-semibold",
                      )}
                    >
                      <Excerpt text={primaryText} terms={terms} />
                    </div>
                    {secondaryText && (
                      <div
                        lang={secondaryLang}
                        className="mt-0.5 text-[12.5px] leading-snug text-[var(--fg-muted)]"
                      >
                        <Excerpt text={secondaryText} terms={terms} max={110} />
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
};
