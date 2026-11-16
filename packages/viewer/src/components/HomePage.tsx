import React, { useState } from "react";
import { ArrowRight, ChevronDown, GitCommitHorizontal, Tag } from "lucide-react";
import type { SiteIndex, SiteSnapshot, SiteVolume, VolumeId } from "../types";
import type { ReadingLang } from "../lib/settings";
import {
  cleanVolumeTitle,
  findChapter,
  formatDate,
  formatTocChapterTitle,
  parseTouchedChapter,
  shortSha,
  snapshotRef,
  VOLUME_NUMERAL,
} from "../lib/snapshots";
import { formatHash } from "../lib/route";
import { cx } from "./ui";

interface HomePageProps {
  index: SiteIndex;
  snapshot: SiteSnapshot;
  volumes: SiteVolume[];
  vParam?: string;
  lang: ReadingLang;
}

const MOBILE_PREVIEW_LIMIT = 12;

export const HomePage: React.FC<HomePageProps> = ({
  index,
  snapshot,
  volumes: rawVolumes,
  vParam,
  lang,
}) => {
  const [expandedVols, setExpandedVols] = useState<Record<string, boolean>>({});
  const volumes = rawVolumes.filter((v) => v.chapters.length > 0);
  const firstVol = volumes[0];
  const startChapter =
    firstVol?.chapters.find((c) => c.sectnum !== null) ?? firstVol?.chapters[0];
  const chapterHref = (volume: VolumeId, chapter: string) =>
    formatHash({ page: "chapter", volume, chapter, v: vParam });

  const recent = [...index.snapshots].reverse().slice(0, 8);
  const approvedPct = Math.round(snapshot.approval_ratio * 100);

  return (
    <div className="mx-auto w-full max-w-[60rem] pb-20 sm:pb-24">
      {/* --------------------------------------------------------- hero */}
      <section className="pt-2 pb-9 sm:pt-4 sm:pb-12">
        <div className="mb-3.5 inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--line)] px-3 py-1 text-[12px] text-[var(--fg-muted)] sm:mb-4 sm:text-[12.5px]">
          {snapshot.ratified_tag ? (
            <>
              <Tag className="h-3.5 w-3.5 shrink-0 text-[var(--add-line)]" />
              <span className="truncate font-medium">{snapshot.ratified_tag}</span>
            </>
          ) : (
            <>
              <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0" />
              <span className="font-mono">{shortSha(snapshot.sha)}</span>
            </>
          )}
          <span className="shrink-0 text-[var(--fg-faint)]">· {formatDate(snapshot.date)}</span>
        </div>
        <h1 className="text-[1.95rem] leading-tight font-bold tracking-tight sm:text-[2.75rem]">
          RISC-V 指令集手册
        </h1>
        <p className="mt-2 text-[15px] text-[var(--fg-muted)] sm:mt-2.5 sm:text-[16.5px]">
          同步{" "}
          <a
            className="text-[var(--accent-fg)] hover:underline"
            href={index.upstream_repo_url}
            target="_blank"
            rel="noreferrer"
          >
            riscv/riscv-isa-manual
          </a>{" "}
          的中英双语社区译本
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3 sm:mt-7">
          {firstVol && startChapter && (
            <a
              href={chapterHref(firstVol.id, startChapter.id)}
              className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-[14px] font-medium text-white transition-opacity hover:opacity-90 dark:text-[#141519]"
            >
              开始阅读 <ArrowRight className="h-4 w-4" />
            </a>
          )}
          <span className="text-[13px] text-[var(--fg-faint)]">{approvedPct}% 已审校</span>
        </div>
      </section>

      {/* ------------------------------------------------------ volumes */}
      <section className="space-y-4 sm:space-y-6">
        {volumes.map((vol) => {
          const chapters = vol.chapters;
          const isExpanded = Boolean(expandedVols[vol.id]);
          const hasMobileOverflow = chapters.length > MOBILE_PREVIEW_LIMIT + 2;
          return (
            <div
              key={vol.id}
              className="rounded-2xl border border-[var(--line)] bg-[var(--bg-elevated)] p-4 sm:p-6"
            >
              <div className="flex items-baseline justify-between gap-3 border-b border-[var(--line)] pb-3 sm:pb-3.5">
                <h2 className="flex items-baseline gap-2.5 text-[16.5px] leading-snug font-semibold sm:text-[17.5px]">
                  {VOLUME_NUMERAL[vol.id] && (
                    <span className="font-mono text-[14px] font-semibold text-[var(--fg-faint)]">
                      {VOLUME_NUMERAL[vol.id]}
                    </span>
                  )}
                  <span>{cleanVolumeTitle(vol, lang)}</span>
                </h2>
                <span className="shrink-0 font-mono text-[12px] text-[var(--fg-faint)]">
                  {lang === "en" ? `${chapters.length}` : `${chapters.length} 章`}
                </span>
              </div>
              <ol className="mt-3 sm:mt-3.5 sm:columns-2 sm:gap-x-8">
                {chapters.map((ch, idx) => {
                  const { title } = formatTocChapterTitle(ch, lang);
                  const hiddenOnMobile = hasMobileOverflow && !isExpanded && idx >= MOBILE_PREVIEW_LIMIT;
                  return (
                    <li
                      key={ch.id}
                      className={cx("break-inside-avoid", hiddenOnMobile && "hidden sm:block")}
                    >
                      <a
                        href={chapterHref(vol.id, ch.id)}
                        className="group flex items-baseline gap-2.5 rounded-md px-2 py-2 text-[14px] leading-snug text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)] active:bg-[var(--bg-subtle)] sm:py-1.5 sm:text-[13.5px]"
                      >
                        <span className="w-6 shrink-0 text-right font-mono text-[12px] tabular-nums text-[var(--fg-faint)] group-hover:text-[var(--fg-muted)]">
                          {ch.sectnum ?? "·"}
                        </span>
                        <span className="min-w-0 flex-1">{title}</span>
                      </a>
                    </li>
                  );
                })}
              </ol>
              {hasMobileOverflow && !isExpanded && (
                <button
                  type="button"
                  onClick={() => setExpandedVols((prev) => ({ ...prev, [vol.id]: true }))}
                  className="mt-2 flex w-full cursor-pointer items-center justify-center gap-1 rounded-lg border border-[var(--line)] py-2 text-[13px] text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-subtle)] active:bg-[var(--bg-subtle)] sm:hidden"
                >
                  <span>展开全部 {chapters.length} 章</span>
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </section>

      {/* ------------------------------------------------ recent changes */}
      <section className="mt-12 sm:mt-16">
        <h2 className="text-[17px] font-semibold">上游更新</h2>
        <ol className="mt-3.5 divide-y divide-[var(--line)] border-y border-[var(--line)] sm:mt-4">
          {recent.map((s) => {
            const parent = s.parent_sha
              ? index.snapshots.find((x) => x.sha === s.parent_sha)
              : undefined;
            const allValidTouched = s.diff.touched_chapters
              .map(parseTouchedChapter)
              .filter((t): t is NonNullable<typeof t> => Boolean(t));
            const touched = allValidTouched.slice(0, 4);
            const diffStats = s.is_baseline ? (
              <span className="text-[var(--fg-faint)]">初始基线</span>
            ) : (
              <>
                <span className="text-[var(--add-line)]">+{s.diff.added}</span>{" "}
                <span className="text-[var(--mod-line)]">~{s.diff.modified}</span>{" "}
                <span className="text-[var(--del-line)]">−{s.diff.deleted}</span>
              </>
            );
            return (
              <li key={s.sha} className="flex flex-col gap-1.5 py-3.5 sm:flex-row sm:gap-5">
                <div className="flex items-center justify-between gap-2 text-[12.5px] text-[var(--fg-faint)] sm:block sm:w-28 sm:shrink-0">
                  <div className="flex items-center gap-2 sm:block">
                    <span>{formatDate(s.date)}</span>
                    <div className="font-mono">{s.ratified_tag ?? shortSha(s.sha)}</div>
                  </div>
                  <div className="font-mono text-[12px] sm:hidden">{diffStats}</div>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] leading-snug text-[var(--fg)]">{s.title}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {touched.map((t) => {
                      const ch =
                        findChapter(rawVolumes, t.volume, t.chapter) ??
                        findChapter(index.default_volumes, t.volume, t.chapter);
                      return (
                        <a
                          key={`${t.volume}/${t.chapter}`}
                          href={formatHash({
                            page: "chapter",
                            volume: t.volume,
                            chapter: t.chapter,
                            v: snapshotRef(s),
                            cmp: parent ? snapshotRef(parent) : undefined,
                          })}
                          className="max-w-full truncate rounded-md bg-[var(--bg-subtle)] px-2 py-1 text-[12px] text-[var(--fg-muted)] transition-colors hover:text-[var(--accent-fg)] active:bg-[var(--line)] sm:max-w-[18rem] sm:py-0.5"
                        >
                          {ch ? formatTocChapterTitle(ch, lang).title : t.chapter}
                        </a>
                      );
                    })}
                    {allValidTouched.length > touched.length && (
                      <span className="px-1 py-0.5 text-[12px] text-[var(--fg-faint)]">
                        等 {allValidTouched.length} 章
                      </span>
                    )}
                  </div>
                </div>
                <div className="hidden shrink-0 font-mono text-[12px] text-[var(--fg-faint)] sm:block">
                  {diffStats}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <footer className="mt-16 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] leading-relaxed text-[var(--fg-faint)]">
        <span>原文版权归 RISC-V International 所有，译文仅供参考，请以英文原文为准。</span>
        {index.data_repo_url && (
          <a href={index.data_repo_url} target="_blank" rel="noreferrer" className="text-[var(--accent-fg)] hover:underline">
            参与改进 →
          </a>
        )}
      </footer>
    </div>
  );
};
