import React, { memo, useEffect, useState } from "react";
import { Info, Languages, Link2 } from "lucide-react";
import type { RenderedUnit } from "../types";
import type { ReadingLang } from "../lib/settings";
import { STATUS_LABEL } from "../lib/snapshots";
import { DATA_BASE_URL } from "../utils/dataClient";
import { cx } from "./ui";

export interface DocBlockProps {
  unitId: string;
  block: RenderedUnit;
  /** Heading level (2..6) when `block.kind === "heading"`. */
  level?: number;
  anchorId?: string;
  extraAnchors?: string[];
  /** For headings that open a section: the section id (used as the DOM id). */
  sectionId?: string;
  /** Canonical AsciiDoc section number (e.g. "2.1", "A.1"), or null when unnumbered. */
  sectnum?: string | null;
  lang: ReadingLang;
  tapToReveal: boolean;
  showAnchors: boolean;
  /** Href (route hash) linking to this block. */
  permalink: string;
  onInspect: (unitId: string) => void;
  onCopyLink: (href: string) => void;
  /** Compare mode: replace the rendered content of each language. */
  zhOverride?: React.ReactNode;
  enOverride?: React.ReactNode;
  className?: string;
  /** Rendered above the content (compare labels). */
  label?: React.ReactNode;
  domId?: string;
  /** Plain-text section title fallback when heading HTML is empty. */
  fallbackHeadingTitle?: string;
}

/**
 * Scope per-fragment footnote IDs so multiple blocks and bilingual views never
 * collide, and resolve `./data/assets/` against custom `VITE_DATA_URL`.
 */
export function prepareBlockHtml(html: string, scopeKey: string): string {
  let out = html;
  if (out.includes("_footnote")) {
    out = out
      .replace(/id=(["'])_footnoteref_(\d+)\1/g, `id=$1fn-${scopeKey}-ref-$2$1`)
      .replace(/id=(["'])_footnotedef_(\d+)\1/g, `id=$1fn-${scopeKey}-def-$2$1`)
      .replace(/href=(["'])#_footnoteref_(\d+)\1/g, `href=$1#fn-${scopeKey}-ref-$2$1`)
      .replace(/href=(["'])#_footnotedef_(\d+)\1/g, `href=$1#fn-${scopeKey}-def-$2$1`);
  }
  if (DATA_BASE_URL !== "./data" && out.includes("./data/assets/")) {
    out = out.replace(/src=(["'])\.\/data\/assets\//g, `src=$1${DATA_BASE_URL}/assets/`);
  }
  return out;
}

/** Rendered AsciiDoc HTML for one language. */
const Html: React.FC<{ html: string; lang: "zh-CN" | "en"; scopeKey: string; scrollX?: boolean }> = ({
  html,
  lang,
  scopeKey,
  scrollX,
}) => (
  <div
    lang={lang}
    className={cx("doc-prose", scrollX && "doc-scroll-x")}
    dangerouslySetInnerHTML={{ __html: prepareBlockHtml(html, scopeKey) }}
  />
);

/** `<h3 id="…">Title</h3>` → `Title` (keeps inline markup). */
function headingInner(html: string): string {
  const m = html.match(/^\s*<h\d[^>]*>([\s\S]*?)<\/h\d>\s*$/i);
  if (m) return m[1];
  return html.replace(/<\/?(h\d|div)[^>]*>/gi, "").trim();
}

function isInteractive(target: EventTarget | null): boolean {
  return Boolean(
    (target as HTMLElement | null)?.closest?.("a, button, summary, input, select, textarea"),
  );
}

const DocBlockImpl: React.FC<DocBlockProps> = ({
  unitId,
  block,
  level,
  anchorId,
  extraAnchors,
  sectionId,
  sectnum,
  lang,
  tapToReveal,
  showAnchors,
  permalink,
  onInspect,
  onCopyLink,
  zhOverride,
  enOverride,
  className,
  label,
  domId,
  fallbackHeadingTitle,
}) => {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => setRevealed(false), [lang]);

  const zhHtml = block.zh_html ?? "";
  const hasZh = Boolean(zhOverride) || Boolean(zhHtml.trim());
  const isUntranslated = block.translatable && (!hasZh || block.status === "untranslated");
  const effectiveStatus = isUntranslated
    ? "untranslated"
    : (block.status ?? (block.translatable ? "machine" : "approved"));
  const statusText = isUntranslated ? "未翻译" : STATUS_LABEL[effectiveStatus];
  const single = lang === "zh" || lang === "en";
  const canReveal = block.translatable && single && block.kind !== "heading" && !isUntranslated;

  const handleTapToggle = (e: React.MouseEvent, touchOnly = false) => {
    if (!tapToReveal || isInteractive(e.target)) return;
    if (touchOnly && !window.matchMedia("(hover: none)").matches) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    setRevealed((v) => !v);
  };

  const toolsBar = (
    <div className="doc-original-tools">
      {block.translatable && <span>{statusText}</span>}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onInspect(unitId);
        }}
      >
        详情与改进
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onCopyLink(permalink);
        }}
      >
        复制链接
      </button>
    </div>
  );

  const actions = (
    <div className="doc-actions" aria-label="段落操作">
      <div className="doc-actions-list">
        <button
          type="button"
          className="doc-action"
          title="复制本段链接"
          onClick={() => onCopyLink(permalink)}
        >
          <Link2 className="h-3.5 w-3.5" />
        </button>
        {canReveal && (
          <button
            type="button"
            className="doc-action"
            data-active={revealed ? "true" : undefined}
            title={lang === "zh" ? "显示英文原文" : "显示中文译文"}
            onClick={() => setRevealed((v) => !v)}
          >
            <Languages className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          className="doc-action"
          title="段落详情 · 历史 · 参与改进"
          onClick={() => onInspect(unitId)}
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );

  const anchorChip =
    showAnchors && anchorId ? (
      <a className="doc-anchor-chip" href={permalink} title="规范锚点">
        #{anchorId}
      </a>
    ) : null;

  const rootDomId = domId ?? `unit-${unitId}`;
  const secondaryAnchors = (() => {
    const out: string[] = [];
    const seen = new Set<string>([rootDomId]);
    if (sectionId) seen.add(sectionId);
    for (const cand of [anchorId, ...(extraAnchors ?? [])]) {
      if (!cand || seen.has(cand)) continue;
      seen.add(cand);
      out.push(cand);
    }
    return out;
  })();

  const hiddenAnchors = secondaryAnchors.map((id) => (
    <span key={id} id={id} className="sr-only" aria-hidden="true" />
  ));

  const common = {
    id: rootDomId,
    "data-unit-id": unitId,
    "data-anchor": anchorId,
    "data-kind": block.kind,
    "data-status": effectiveStatus,
    "data-translatable": String(block.translatable),
    ...(isUntranslated ? { "data-untranslated": "true" } : {}),
  };

  // ---------------------------------------------------------------- headings
  if (block.kind === "heading") {
    const headingLevel = Math.min(6, Math.max(2, level ?? 2));
    const Tag = `h${headingLevel}` as "h2";
    const zh = isUntranslated ? "" : headingInner(zhHtml);
    const en = headingInner(block.en_html);
    const primary = lang === "en" ? en : zh || en;
    const showSub =
      !isUntranslated &&
      (lang === "parallel" || lang === "interleave") &&
      Boolean(zh) &&
      Boolean(en) &&
      en !== zh;
    const override =
      lang === "en" ? (enOverride ?? zhOverride) : (zhOverride ?? enOverride);
    const primaryLang = lang === "en" || isUntranslated ? "en" : "zh-CN";
    return (
      <div {...common} data-level={headingLevel} className={cx("doc-block", className)}>
        {hiddenAnchors}
        <span className="doc-mark" title={block.translatable ? statusText : undefined} />
        {actions}
        {label}
        <Tag id={sectionId} data-level={headingLevel} className="doc-heading">
          {sectnum && <span className="doc-sectnum">{sectnum} </span>}
          {override ? (
            override
          ) : primary ? (
            <span
              lang={primaryLang}
              dangerouslySetInnerHTML={{ __html: primary }}
            />
          ) : (
            <span lang={primaryLang}>{fallbackHeadingTitle ?? ""}</span>
          )}
          <a className="doc-permalink" href={permalink} aria-label="本节链接">
            #
          </a>
          <button
            type="button"
            className="doc-touch-inspect"
            aria-label="标题详情"
            onClick={() => onInspect(unitId)}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
          {showSub && !override && (
            <span
              lang="en"
              className="doc-heading-sub"
              dangerouslySetInnerHTML={{ __html: en }}
            />
          )}
        </Tag>
      </div>
    );
  }

  const scrollX = block.kind === "table";
  const scopeBase = unitId.slice(0, 10);
  const hasEn = Boolean(enOverride) || Boolean(block.en_html.trim());
  const zhNode = zhOverride ?? (
    <Html html={zhHtml} lang="zh-CN" scopeKey={`${scopeBase}-zh`} scrollX={scrollX} />
  );
  const enNode =
    enOverride ??
    (hasEn ? (
      <Html html={block.en_html} lang="en" scopeKey={`${scopeBase}-en`} scrollX={scrollX} />
    ) : (
      <div className="doc-prose doc-untranslated-empty">此段落尚未同步原文与译文</div>
    ));

  // --------------------------------------------- language-neutral (code, diagram…)
  if (!block.translatable) {
    return (
      <div
        {...common}
        className={cx("doc-block", className)}
        onClick={(e) => handleTapToggle(e, true)}
      >
        {hiddenAnchors}
        <span className="doc-mark" />
        {actions}
        {label}
        {anchorChip}
        {enOverride ?? (
          <Html
            html={block.en_html || zhHtml}
            lang="en"
            scopeKey={`${scopeBase}-neutral`}
            scrollX
          />
        )}
        {revealed && <div className="doc-touch-drawer fade-in">{toolsBar}</div>}
      </div>
    );
  }

  // ------------------------------------------------------------ translatable
  let body: React.ReactNode;
  if (isUntranslated) {
    body = (
      <div onClick={(e) => handleTapToggle(e, true)}>
        {enNode}
        {revealed && <div className="doc-touch-drawer fade-in">{toolsBar}</div>}
      </div>
    );
  } else if (lang === "parallel") {
    body = (
      <div onClick={(e) => handleTapToggle(e, true)}>
        <div className="doc-parallel">
          <div className="doc-col-primary min-w-0">{zhNode}</div>
          <div className="doc-col-secondary min-w-0">{enNode}</div>
        </div>
        {revealed && <div className="doc-touch-drawer fade-in">{toolsBar}</div>}
      </div>
    );
  } else if (lang === "interleave") {
    body = (
      <div onClick={(e) => handleTapToggle(e, true)}>
        <div className="doc-interleave-primary">{zhNode}</div>
        <div className="doc-interleave-sub">{enNode}</div>
        {revealed && <div className="doc-touch-drawer fade-in">{toolsBar}</div>}
      </div>
    );
  } else {
    const primary = lang === "zh" ? zhNode : enNode;
    const secondary = lang === "zh" ? enNode : zhNode;
    body = (
      <div
        className={cx(tapToReveal && "doc-tappable")}
        onClick={(e) => handleTapToggle(e, false)}
      >
        {primary}
        {revealed && (
          <div className="doc-reveal-drawer fade-in">
            {secondary}
            {toolsBar}
          </div>
        )}
      </div>
    );
  }

  return (
    <div {...common} className={cx("doc-block", className)}>
      {hiddenAnchors}
      <span className="doc-mark" title={statusText} />
      {actions}
      {label}
      {anchorChip}
      {body}
    </div>
  );
};

export const DocBlock = memo(DocBlockImpl);
