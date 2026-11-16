import React, { useMemo } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  GitCommitHorizontal,
  History,
  Tag,
} from "lucide-react";
import {
  normalizeBlockEntry,
  type CompareRow,
  type ResolvedChapter,
  type SiteChapter,
  type SiteSnapshot,
} from "../types";
import type { ReaderSettings } from "../lib/settings";
import {
  bundleProgress,
  cleanChapterTitle,
  formatDate,
  formatTocChapterTitle,
  shortSha,
} from "../lib/snapshots";
import { DocBlock } from "./DocBlock";
import { CompareBody } from "./CompareBody";
import { Spinner, cx } from "./ui";

export interface CompareState {
  base: SiteSnapshot;
  target: SiteSnapshot;
  baseBundle: ResolvedChapter | null;
  rows: CompareRow[];
  changesOnly: boolean;
  activeRowKey: string | null;
}

interface ChapterPageProps {
  snapshot: SiteSnapshot;
  chapter: SiteChapter;
  bundle: ResolvedChapter | null;
  loading: boolean;
  error: string | null;
  settings: ReaderSettings;
  compare: CompareState | null;
  /** Number of blocks this snapshot changed in the chapter (vs. its parent). */
  changedHere: number;
  prevChapter?: SiteChapter;
  nextChapter?: SiteChapter;
  makePermalink: (at: string) => string;
  chapterHref: (chapterId: string) => string;
  onShowChanges?: () => void;
  onInspect: (unitId: string) => void;
  onCopyLink: (href: string) => void;
}

const ProgressMeter: React.FC<{ bundle: ResolvedChapter }> = ({ bundle }) => {
  const p = useMemo(() => bundleProgress(bundle), [bundle]);
  if (p.total === 0) return null;
  const pct = (n: number) => `${(n / p.total) * 100}%`;
  const approvedPct = Math.round((p.approved / p.total) * 100);
  const summaryParts = [
    `已审校 ${p.approved}`,
    `机器翻译 ${p.machine}`,
  ];
  if (p.untranslated > 0) summaryParts.push(`未翻译 ${p.untranslated}`);
  return (
    <span
      className="inline-flex items-center gap-2"
      title={summaryParts.join(" · ")}
    >
      <span className="flex h-1.5 w-16 overflow-hidden rounded-full bg-[var(--bg-subtle)]">
        <span className="bg-[var(--add-line)]" style={{ width: pct(p.approved) }} />
        <span className="bg-[var(--st-machine)]" style={{ width: pct(p.machine) }} />
      </span>
      <span>{approvedPct}% 已审校</span>
    </span>
  );
};

export const ChapterPage: React.FC<ChapterPageProps> = ({
  snapshot,
  chapter,
  bundle,
  loading,
  error,
  settings,
  compare,
  changedHere,
  prevChapter,
  nextChapter,
  makePermalink,
  chapterHref,
  onShowChanges,
  onInspect,
  onCopyLink,
}) => {
  const headBundle = bundle ?? compare?.baseBundle ?? null;
  const lang = settings.lang;
  const sectnum = headBundle ? headBundle.sectnum : chapter.sectnum;
  const sectname = headBundle ? headBundle.sectname : chapter.sectname;

  const titleZh = cleanChapterTitle(headBundle?.title_zh || chapter.title_zh || chapter.title_en);
  const titleEn = cleanChapterTitle(headBundle?.title_en || chapter.title_en);
  const title = lang === "en" ? titleEn : titleZh;
  const subtitle = lang === "en" ? (titleZh !== titleEn ? titleZh : null) : titleZh !== titleEn ? titleEn : null;

  // The chapter's own level-1 heading is shown in the hero instead.
  const titleUnitId = headBundle?.title_unit_id;

  const body = useMemo(() => {
    if (!bundle || compare) return null;
    const out: React.ReactNode[] = [];
    for (const sec of bundle.sections) {
      if (sec.level > 1) {
        const headingBlock = sec.heading_unit_id
          ? bundle.units[sec.heading_unit_id]
          : undefined;
        if (sec.heading_unit_id && sec.heading_unit_id !== titleUnitId && headingBlock) {
          const anchorId = sec.heading_anchor_id;
          const at = sec.id || anchorId || `u-${sec.heading_unit_id.slice(0, 12)}`;
          const fallbackHeadingTitle =
            lang === "en" ? sec.title_en : sec.title_zh || sec.title_en;
          out.push(
            <DocBlock
              key={`${sec.id}:heading:${sec.heading_unit_id}`}
              unitId={sec.heading_unit_id}
              block={headingBlock}
              level={sec.level}
              anchorId={anchorId}
              extraAnchors={sec.heading_extra_anchors}
              sectionId={sec.id}
              sectnum={sec.sectnum}
              fallbackHeadingTitle={fallbackHeadingTitle}
              lang={lang}
              tapToReveal={settings.tapToReveal}
              showAnchors={settings.showAnchors}
              permalink={makePermalink(at)}
              onInspect={onInspect}
              onCopyLink={onCopyLink}
            />,
          );
        } else {
          out.push(<span key={`anchor-${sec.id}`} id={sec.id} />);
          if (sec.heading_anchor_id && sec.heading_anchor_id !== sec.id) {
            out.push(
              <span key={`anchor-${sec.id}-${sec.heading_anchor_id}`} id={sec.heading_anchor_id} />,
            );
          }
          for (const extra of sec.heading_extra_anchors ?? []) {
            if (extra && extra !== sec.id && extra !== sec.heading_anchor_id) {
              out.push(<span key={`anchor-${sec.id}-${extra}`} id={extra} />);
            }
          }
        }
      } else {
        if (sec.heading_anchor_id) {
          out.push(
            <span key={`anchor-${sec.id}-${sec.heading_anchor_id}`} id={sec.heading_anchor_id} />,
          );
        }
        for (const extra of sec.heading_extra_anchors ?? []) {
          if (extra && extra !== sec.heading_anchor_id) {
            out.push(<span key={`anchor-${sec.id}-${extra}`} id={extra} />);
          }
        }
      }

      sec.blocks.forEach((entry, i) => {
        const ref = normalizeBlockEntry(entry);
        if (ref.unit_id === titleUnitId) return;
        const block = bundle.units[ref.unit_id];
        if (!block) return;
        const anchorId = ref.anchor_id;
        const at = anchorId ?? `u-${ref.unit_id.slice(0, 12)}`;
        out.push(
          <DocBlock
            key={`${sec.id}:${ref.unit_id}:${i}`}
            unitId={ref.unit_id}
            block={block}
            anchorId={anchorId}
            extraAnchors={ref.extra_anchors}
            sectnum={null}
            lang={lang}
            tapToReveal={settings.tapToReveal}
            showAnchors={settings.showAnchors}
            permalink={makePermalink(at)}
            onInspect={onInspect}
            onCopyLink={onCopyLink}
          />,
        );
      });
    }
    return out;
  }, [bundle, compare, lang, titleUnitId, settings.tapToReveal, settings.showAnchors, makePermalink, onInspect, onCopyLink]);

  return (
    <article
      data-lang={lang}
      className={cx(
        "doc-article mx-auto w-full pb-24",
        lang === "parallel" ? "max-w-[78rem]" : "max-w-[46rem]",
        settings.showStatus && lang !== "en" && "status-on",
      )}
    >
      {/* ------------------------------------------------------------ hero */}
      <header className="mb-8 sm:mb-12">
        <h1
          lang={lang === "en" ? "en" : "zh-CN"}
          className="text-[1.6em] leading-tight font-bold tracking-tight text-[var(--fg)] sm:text-[1.95em]"
        >
          {sectnum && (
            <span className="mr-[0.15em] tabular-nums">
              {sectname === "appendix"
                ? lang === "en"
                  ? `Appendix ${sectnum}:`
                  : `附录 ${sectnum}`
                : `${sectnum}.`}{" "}
            </span>
          )}
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1.5 text-[0.98em] text-[var(--fg-muted)] sm:mt-2 sm:text-[1.05em]">{subtitle}</p>
        )}

        <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-[var(--fg-muted)] sm:mt-4 sm:gap-x-5 sm:gap-y-2 sm:text-[13px]">
          {!compare && (
            <span className="inline-flex items-center gap-1.5">
              {snapshot.ratified_tag ? (
                <>
                  <Tag className="h-3.5 w-3.5" /> {snapshot.ratified_tag}
                </>
              ) : (
                <>
                  <GitCommitHorizontal className="h-3.5 w-3.5" />
                  <span className="font-mono">{shortSha(snapshot.sha)}</span>
                  <span className="text-[var(--fg-faint)]">· {formatDate(snapshot.date)}</span>
                </>
              )}
            </span>
          )}
          {bundle && !compare && <ProgressMeter bundle={bundle} />}
          {!compare && changedHere > 0 && onShowChanges && (
            <button
              type="button"
              onClick={onShowChanges}
              className="inline-flex cursor-pointer items-center gap-1.5 text-[var(--accent-fg)] hover:underline"
            >
              <History className="h-3.5 w-3.5" />
              {changedHere} 处变更
            </button>
          )}
        </div>
      </header>

      {/* ------------------------------------------------------------ body */}
      {loading ? (
        <Spinner label="正在加载章节…" />
      ) : error ? (
        <div className="flex items-start gap-3 rounded-lg bg-[var(--del-bg)] px-4 py-3 text-sm text-[var(--fg-muted)]">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--del-line)]" />
          <div>
            <div className="font-medium text-[var(--fg)]">章节加载失败</div>
            <div className="mt-1 font-mono text-xs">{error}</div>
          </div>
        </div>
      ) : compare ? (
        <CompareBody
          rows={compare.rows}
          settings={settings}
          changesOnly={compare.changesOnly}
          activeRowKey={compare.activeRowKey}
          skipUnitId={titleUnitId}
          makePermalink={makePermalink}
          onInspect={onInspect}
          onCopyLink={onCopyLink}
        />
      ) : (
        <div className="doc-body">{body}</div>
      )}

      {/* ---------------------------------------------------------- footer */}
      {!loading && (prevChapter || nextChapter) && (
        <nav className="mt-12 grid gap-3 border-t border-[var(--line)] pt-6 sm:mt-20 sm:grid-cols-2 sm:pt-8">
          {prevChapter ? (
            <a
              href={chapterHref(prevChapter.id)}
              aria-label="上一章"
              className="group flex items-center gap-3 rounded-xl border border-[var(--line)] px-4 py-3.5 transition-colors hover:border-[var(--line-strong)] hover:bg-[var(--bg-subtle)] active:bg-[var(--bg-subtle)]"
            >
              <ArrowLeft className="h-4 w-4 shrink-0 text-[var(--fg-faint)] transition-transform group-hover:-translate-x-0.5 group-hover:text-[var(--accent-fg)]" />
              <span className="min-w-0 truncate text-[14.5px] font-medium text-[var(--fg)] group-hover:text-[var(--accent-fg)] sm:text-[15px]">
                {prevChapter.sectnum && (
                  <span className="mr-1.5 tabular-nums">
                    {prevChapter.sectname === "appendix"
                      ? lang === "en"
                        ? `Appendix ${prevChapter.sectnum}:`
                        : `附录 ${prevChapter.sectnum}`
                      : `${prevChapter.sectnum}.`}
                  </span>
                )}
                {formatTocChapterTitle(prevChapter, lang).title}
              </span>
            </a>
          ) : (
            <span className="hidden sm:block" />
          )}
          {nextChapter && (
            <a
              href={chapterHref(nextChapter.id)}
              aria-label="下一章"
              className="group flex items-center justify-end gap-3 rounded-xl border border-[var(--line)] px-4 py-3.5 text-right transition-colors hover:border-[var(--line-strong)] hover:bg-[var(--bg-subtle)] active:bg-[var(--bg-subtle)]"
            >
              <span className="min-w-0 truncate text-[14.5px] font-medium text-[var(--fg)] group-hover:text-[var(--accent-fg)] sm:text-[15px]">
                {nextChapter.sectnum && (
                  <span className="mr-1.5 tabular-nums">
                    {nextChapter.sectname === "appendix"
                      ? lang === "en"
                        ? `Appendix ${nextChapter.sectnum}:`
                        : `附录 ${nextChapter.sectnum}`
                      : `${nextChapter.sectnum}.`}
                  </span>
                )}
                {formatTocChapterTitle(nextChapter, lang).title}
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-[var(--fg-faint)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--accent-fg)]" />
            </a>
          )}
        </nav>
      )}
    </article>
  );
};
