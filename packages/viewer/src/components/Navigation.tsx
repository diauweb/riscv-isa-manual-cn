import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { ResolvedChapter, SiteVolume, VolumeId } from "../types";
import type { ReadingLang } from "../lib/settings";
import { useBodyScrollLock } from "../lib/scroll";
import {
  cleanChapterTitle,
  formatTocChapterTitle,
  shortVolumeLabel,
} from "../lib/snapshots";
import { IconButton, Segmented, cx } from "./ui";

export interface TocSection {
  id: string;
  level: number;
  sectnum: string | null;
  title: string;
}

/** Scroll `box` (not the window) so `el` is visible. */
function keepInView(box: HTMLElement, el: HTMLElement, margin: number, center = false) {
  const b = box.getBoundingClientRect();
  if (b.height === 0) return;
  const r = el.getBoundingClientRect();
  if (r.top >= b.top + margin && r.bottom <= b.bottom - margin) return;
  const offset = r.top - b.top + box.scrollTop;
  box.scrollTop = center
    ? offset - box.clientHeight / 2 + r.height / 2
    : r.top < b.top + margin
      ? offset - margin
      : offset - box.clientHeight + r.height + margin;
}

export function tocSections(
  chapter: ResolvedChapter | null,
  lang: ReadingLang,
): TocSection[] {
  if (!chapter) return [];
  return chapter.sections
    .filter((s) => s.level >= 2 && s.level <= 4)
    .map((s) => ({
      id: s.id,
      level: s.level,
      sectnum: s.sectnum,
      title: cleanChapterTitle((lang === "en" ? s.title_en : s.title_zh) || s.title_en),
    }));
}

interface BookNavProps {
  volumes: SiteVolume[];
  activeVolumeId?: VolumeId;
  activeChapterId?: string;
  sections: TocSection[];
  activeSectionId: string | null;
  /** Show the active chapter's sections inline (when the right rail is hidden). */
  inlineSections: "always" | "below-xl";
  lang: ReadingLang;
  page: "home" | "chapter";
  chapterHref: (volume: VolumeId, chapterId: string) => string;
  sectionHref: (sectionId: string) => string;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onSelectVolume: (v: VolumeId) => void;
}

const BookNavContent: React.FC<
  BookNavProps & {
    filter: string;
    onChangeFilter: (v: string) => void;
    isMobileDrawer?: boolean;
  }
> = ({
  volumes,
  activeVolumeId,
  activeChapterId,
  sections,
  activeSectionId,
  inlineSections,
  lang,
  page,
  chapterHref,
  sectionHref,
  onCloseMobile,
  onSelectVolume,
  filter,
  onChangeFilter,
  isMobileDrawer,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const volume = volumes.find((v) => v.id === activeVolumeId) ?? volumes[0];

  const chapters = useMemo(() => {
    const all = volume?.chapters ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return all;
    return all.filter((c) =>
      `${c.sectnum ?? ""} ${c.title_zh} ${c.title_en} ${c.id}`.toLowerCase().includes(q),
    );
  }, [volume, filter]);

  // Keep the active section or active chapter visible in the sidebar/drawer.
  useEffect(() => {
    const box = listRef.current;
    if (!box) return;
    const el =
      box.querySelector<HTMLElement>("[data-active-section]") ??
      box.querySelector<HTMLElement>("[data-active-chapter]");
    if (el) keepInView(box, el, 16, true);
  }, [activeChapterId, activeVolumeId, isMobileDrawer]);

  return (
    <div className="flex h-full flex-col">
      {isMobileDrawer && (
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2">
          {volumes.length > 1 ? (
            <Segmented
              className="min-w-0 flex-1"
              value={volume?.id ?? "unpriv"}
              onChange={(v) => onSelectVolume(v as VolumeId)}
              options={volumes.map((v) => ({
                value: v.id,
                label: shortVolumeLabel(v, lang),
              }))}
            />
          ) : (
            <div className="flex-1" />
          )}
          <IconButton onClick={onCloseMobile} aria-label="关闭目录" className="-mr-1">
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      )}

      <div className="px-3 pt-3 pb-2">
        <label className="flex items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[16px] focus-within:border-[var(--line-strong)] sm:text-[13px]">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--fg-faint)]" />
          <input
            value={filter}
            onChange={(e) => onChangeFilter(e.target.value)}
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="筛选章节…"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--fg-faint)]"
          />
          {filter && (
            <button
              type="button"
              onClick={() => onChangeFilter("")}
              aria-label="清除筛选"
              className="cursor-pointer p-0.5 text-[var(--fg-faint)] active:text-[var(--fg)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </label>
      </div>

      <div
        ref={listRef}
        className="scroll-quiet flex-1 overflow-y-auto overscroll-contain px-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
      >
        <ul className="space-y-0.5 lg:space-y-px">
          {chapters.map((ch) => {
            const active = page === "chapter" && ch.id === activeChapterId;
            const { title } = formatTocChapterTitle(ch, lang);
            return (
              <li key={ch.id}>
                <a
                  href={chapterHref(volume.id, ch.id)}
                  onClick={onCloseMobile}
                  data-active-chapter={active ? "" : undefined}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "group flex items-baseline gap-2 rounded-md px-2 py-2 text-[14px] leading-snug transition-colors lg:py-[0.4rem] lg:text-[13.5px]",
                    active
                      ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-fg)]"
                      : "text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)] active:bg-[var(--bg-subtle)]",
                  )}
                >
                  <span
                    className={cx(
                      "w-6 shrink-0 text-right font-mono text-[11.5px] tabular-nums",
                      active ? "text-[var(--accent-fg)] opacity-80" : "text-[var(--fg-faint)]",
                    )}
                  >
                    {ch.sectnum ?? "·"}
                  </span>
                  <span className="min-w-0 flex-1">{title}</span>
                </a>
                {active && sections.length > 0 && (
                  <ul
                    className={cx(
                      "my-1 ml-3 border-l border-[var(--line)] py-0.5",
                      inlineSections === "below-xl" && "xl:hidden",
                    )}
                  >
                    {sections
                      .filter((s) => s.level <= 3)
                      .map((s) => {
                        const secActive = activeSectionId === s.id;
                        return (
                          <li key={s.id}>
                            <a
                              href={sectionHref(s.id)}
                              onClick={onCloseMobile}
                              data-active-section={secActive ? "" : undefined}
                              className={cx(
                                "-ml-px block border-l py-1.5 pr-2 text-[13px] leading-snug transition-colors lg:py-1 lg:text-[12.5px]",
                                s.level === 3 ? "pl-6" : "pl-3",
                                secActive
                                  ? "border-[var(--accent)] font-medium text-[var(--accent-fg)]"
                                  : "border-transparent text-[var(--fg-faint)] hover:text-[var(--fg)] active:text-[var(--fg)]",
                              )}
                            >
                              {s.sectnum && (
                                <span className="mr-1.5 tabular-nums opacity-80">
                                  {s.sectnum}
                                </span>
                              )}
                              {s.title}
                            </a>
                          </li>
                        );
                      })}
                  </ul>
                )}
              </li>
            );
          })}
          {chapters.length === 0 && (
            <li className="px-3 py-6 text-center text-xs text-[var(--fg-faint)]">
              没有匹配的章节
            </li>
          )}
        </ul>
      </div>
    </div>
  );
};

export const BookNav: React.FC<BookNavProps> = (props) => {
  const [filter, setFilter] = useState("");
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const { mobileOpen, onCloseMobile } = props;

  useBodyScrollLock(mobileOpen);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseMobile();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen, onCloseMobile]);

  return (
    <>
      <aside className="hidden w-[17rem] shrink-0 border-r border-[var(--line)] lg:block">
        <div className="sticky top-[var(--header-h)] h-[calc(100dvh-var(--header-h))]">
          <BookNavContent {...props} filter={filter} onChangeFilter={setFilter} />
        </div>
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="fade-in absolute inset-0 bg-black/30" onClick={onCloseMobile} />
          <aside
            onTouchStart={(e) => {
              const t = e.touches[0];
              if (t) touchStart.current = { x: t.clientX, y: t.clientY };
            }}
            onTouchEnd={(e) => {
              const start = touchStart.current;
              touchStart.current = null;
              const t = e.changedTouches[0];
              if (!start || !t) return;
              const dx = t.clientX - start.x;
              const dy = t.clientY - start.y;
              if (dx < -50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                onCloseMobile();
              }
            }}
            className="slide-in-left absolute inset-y-0 left-0 h-dvh w-[19.5rem] max-w-[86vw] bg-[var(--bg)] pl-[env(safe-area-inset-left)] shadow-xl"
          >
            <BookNavContent
              {...props}
              filter={filter}
              onChangeFilter={setFilter}
              isMobileDrawer
            />
          </aside>
        </div>
      )}
    </>
  );
};

export const PageToc: React.FC<{
  sections: TocSection[];
  activeId: string | null;
  sectionHref: (id: string) => string;
  footer?: React.ReactNode;
}> = ({ sections, activeId, sectionHref, footer }) => {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const box = listRef.current?.parentElement;
    const el = listRef.current?.querySelector<HTMLElement>("[data-toc-active]");
    if (el && box) keepInView(box, el, 40);
  }, [activeId]);

  return (
    <div className="sticky top-[calc(var(--header-h)+2rem)] flex max-h-[calc(100vh-var(--header-h)-4rem)] flex-col">
      {sections.length > 0 && (
        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
          <ul ref={listRef} className="border-l border-[var(--line)]">
            {sections.map((s) => {
              const active = s.id === activeId;
              return (
                <li key={s.id}>
                  <a
                    href={sectionHref(s.id)}
                    data-toc-active={active ? "" : undefined}
                    className={cx(
                      "-ml-px block border-l py-[0.3rem] pr-1 text-[12.5px] leading-snug transition-colors",
                      s.level === 2 ? "pl-3" : s.level === 3 ? "pl-6" : "pl-9",
                      active
                        ? "border-[var(--accent)] text-[var(--accent-fg)]"
                        : "border-transparent text-[var(--fg-faint)] hover:text-[var(--fg)]",
                    )}
                  >
                    {s.sectnum && (
                      <span className="mr-1.5 tabular-nums opacity-80">
                        {s.sectnum}
                      </span>
                    )}
                    {s.title}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {footer && <div className="mt-5 shrink-0">{footer}</div>}
    </div>
  );
};
