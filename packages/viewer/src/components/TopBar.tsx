import React, { useEffect, useRef } from "react";
import {
  ArrowRight,
  ArrowUp,
  ChevronDown,
  GitCompareArrows,
  List,
  Menu,
  Search,
  Type,
  X,
} from "lucide-react";
import type { SiteIndex, SiteSnapshot, SiteVolume, VolumeId } from "../types";
import type { ReaderSettings } from "../lib/settings";
import { shortVolumeLabel } from "../lib/snapshots";
import { useScrollProgress } from "../lib/scroll";
import type { TocSection } from "./Navigation";
import { VersionPicker } from "./VersionPicker";
import { IconButton, Kbd, Popover, RiscvLogo, Segmented, Switch, cx } from "./ui";

export interface CompareBarModel {
  base: SiteSnapshot;
  target: SiteSnapshot;
  stats: { added: number; modified: number; moved: number; deleted: number };
  changesOnly: boolean;
  onSelectBase: (s: SiteSnapshot) => void;
  onSelectTarget: (s: SiteSnapshot) => void;
  onToggleChangesOnly: (v: boolean) => void;
  onExit: () => void;
}

interface TopBarProps {
  index: SiteIndex;
  snapshot: SiteSnapshot;
  volumes: SiteVolume[];
  activeVolumeId?: VolumeId;
  chapterId?: string;
  sections?: TocSection[];
  activeSectionId?: string | null;
  sectionHref?: (id: string) => string;
  homeHref: string;
  demoMode: boolean;
  settings: ReaderSettings;
  onUpdateSettings: <K extends keyof ReaderSettings>(k: K, v: ReaderSettings[K]) => void;
  onSelectVolume: (v: VolumeId) => void;
  onSelectSnapshot: (s: SiteSnapshot) => void;
  canCompare: boolean;
  compare: CompareBarModel | null;
  onStartCompare: () => void;
  onOpenSearch: () => void;
  onOpenMobileNav: () => void;
}

const SettingsPanel: React.FC<{
  settings: ReaderSettings;
  update: TopBarProps["onUpdateSettings"];
}> = ({ settings, update }) => (
  <div className="w-full space-y-2.5 px-4 pt-2 pb-4 sm:w-[18.5rem] sm:p-3.5">
    <Segmented
      value={settings.lang}
      onChange={(v) => update("lang", v)}
      options={[
        { value: "zh", label: "中文" },
        { value: "parallel", label: "对照" },
        { value: "interleave", label: "逐段" },
        { value: "en", label: "English" },
      ]}
    />
    <Segmented
      value={settings.fontSize}
      onChange={(v) => update("fontSize", v)}
      options={[
        { value: "sm", label: <span className="text-xs">小</span> },
        { value: "md", label: <span className="text-sm">中</span> },
        { value: "lg", label: <span className="text-base">大</span> },
      ]}
    />
    <Segmented
      value={settings.theme}
      onChange={(v) => update("theme", v)}
      options={[
        { value: "system", label: "跟随系统" },
        { value: "light", label: "浅色" },
        { value: "dark", label: "深色" },
      ]}
    />
    <div className="border-t border-[var(--line)] pt-1.5">
      <Switch
        checked={settings.showStatus}
        onChange={(v) => update("showStatus", v)}
        label="标记未审校译文"
      />
      <Switch
        checked={settings.tapToReveal}
        onChange={(v) => update("tapToReveal", v)}
        label="点击段落展开对照"
      />
      <Switch
        checked={settings.showAnchors}
        onChange={(v) => update("showAnchors", v)}
        label="显示规范锚点"
      />
    </div>
  </div>
);

const MobileSectionList: React.FC<{
  sections: TocSection[];
  activeId: string | null;
  sectionHref: (id: string) => string;
  onPick: () => void;
}> = ({ sections, activeId, sectionHref, onPick }) => {
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const activeEl = listRef.current?.querySelector<HTMLElement>("[data-mobile-toc-active]");
    activeEl?.scrollIntoView({ block: "center" });
  }, []);

  return (
    <div className="flex max-h-[min(28rem,calc(100dvh-8rem))] flex-col">
      <ul
        ref={listRef}
        className="scroll-quiet min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
      >
        {sections.map((s) => {
          const active = s.id === activeId;
          return (
            <li key={s.id}>
              <a
                href={sectionHref(s.id)}
                onClick={onPick}
                data-mobile-toc-active={active ? "" : undefined}
                className={cx(
                  "block rounded-lg py-2 pr-3 text-[13.5px] leading-snug transition-colors sm:py-1.5 sm:text-[13px]",
                  s.level === 2 ? "pl-3" : s.level === 3 ? "pl-6" : "pl-9",
                  active
                    ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-fg)]"
                    : "text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)] active:bg-[var(--bg-subtle)]",
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
      <div className="border-t border-[var(--line)] px-3 py-2">
        <button
          type="button"
          onClick={() => {
            onPick();
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)] active:bg-[var(--bg-subtle)]"
        >
          <ArrowUp className="h-3.5 w-3.5" /> 回到顶部
        </button>
      </div>
    </div>
  );
};

export const TopBar: React.FC<TopBarProps> = ({
  index,
  snapshot,
  volumes,
  activeVolumeId,
  chapterId,
  sections = [],
  activeSectionId = null,
  sectionHref,
  homeHref,
  demoMode,
  settings,
  onUpdateSettings,
  onSelectVolume,
  onSelectSnapshot,
  canCompare,
  compare,
  onStartCompare,
  onOpenSearch,
  onOpenMobileNav,
}) => {
  const progress = useScrollProgress();
  const activeSection = sections.find((s) => s.id === activeSectionId);
  const showSectionBar = Boolean(chapterId && sections.length > 0 && sectionHref && !compare);

  return (
    <header
      id="site-header"
      className="sticky top-0 z-40 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] backdrop-blur-md"
    >
      <div className="flex h-[var(--header-h)] items-center gap-1.5 pl-[max(0.625rem,env(safe-area-inset-left))] pr-[max(0.625rem,env(safe-area-inset-right))] sm:gap-2 sm:pl-[max(1rem,env(safe-area-inset-left))] sm:pr-[max(1rem,env(safe-area-inset-right))]">
        <IconButton className="lg:hidden" onClick={onOpenMobileNav} aria-label="打开目录">
          <Menu className="h-4.5 w-4.5" />
        </IconButton>

        <a href={homeHref} aria-label="RISC-V 指令集手册" className="mr-1 flex shrink-0 items-center gap-2 sm:mr-2">
          <RiscvLogo className="h-7 w-7" />
          <span className="hidden text-[14px] font-semibold sm:block">RISC-V 指令集手册</span>
          {demoMode && (
            <span className="hidden rounded bg-[var(--mod-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--mod-line)] min-[380px]:inline">
              DEMO
            </span>
          )}
        </a>

        {volumes.length > 1 && (
          <nav className="ml-2 hidden items-center gap-1 md:flex">
            {volumes.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => onSelectVolume(v.id)}
                className={cx(
                  "cursor-pointer rounded-md px-2.5 py-1.5 text-[13.5px] transition-colors",
                  activeVolumeId === v.id
                    ? "font-medium text-[var(--fg)]"
                    : "text-[var(--fg-muted)] hover:text-[var(--fg)]",
                )}
              >
                {shortVolumeLabel(v, settings.lang)}
                <span
                  className={cx(
                    "mx-auto mt-0.5 block h-0.5 rounded-full transition-all",
                    activeVolumeId === v.id ? "w-4 bg-[var(--accent)]" : "w-0",
                  )}
                />
              </button>
            ))}
          </nav>
        )}

        <div className="flex-1" />

        <button
          type="button"
          onClick={onOpenSearch}
          className="hidden h-8 w-48 cursor-pointer items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--bg-elevated)] px-2.5 text-[13px] text-[var(--fg-faint)] transition-colors hover:border-[var(--line-strong)] md:flex xl:w-60"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="flex-1 text-left">搜索…</span>
          <Kbd>⌘K</Kbd>
        </button>
        <IconButton className="md:hidden" onClick={onOpenSearch} aria-label="搜索">
          <Search className="h-4 w-4" />
        </IconButton>

        {!compare && (
          <VersionPicker
            index={index}
            value={snapshot}
            onSelect={onSelectSnapshot}
            volumeId={activeVolumeId}
            chapterId={chapterId}
          />
        )}

        {canCompare && !compare && (
          <IconButton onClick={onStartCompare} title="对比版本" aria-label="对比版本">
            <GitCompareArrows className="h-4 w-4" />
            <span className="hidden xl:inline">对比</span>
          </IconButton>
        )}

        <Popover
          align="right"
          ariaLabel="阅读设置"
          panelClassName="w-full sm:w-[18.5rem]"
          trigger={({ open, toggle }) => (
            <IconButton onClick={toggle} active={open} title="阅读设置" aria-label="阅读设置">
              <Type className="h-4 w-4" />
            </IconButton>
          )}
        >
          {() => <SettingsPanel settings={settings} update={onUpdateSettings} />}
        </Popover>
      </div>

      {showSectionBar && sectionHref && (
        <div
          className={cx(
            "flex h-9 items-center justify-between gap-2 border-t border-[var(--line)] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] text-[12.5px] sm:pl-[max(1rem,env(safe-area-inset-left))] sm:pr-[max(1rem,env(safe-area-inset-right))]",
            settings.lang === "parallel" ? "2xl:hidden" : "xl:hidden",
          )}
        >
          <Popover
            align="left"
            ariaLabel="目录"
            className="min-w-0 flex-1"
            panelClassName="w-[22rem]"
            trigger={({ open, toggle }) => (
              <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                className="flex h-8 max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-left transition-colors hover:bg-[var(--bg-subtle)] active:bg-[var(--bg-subtle)]"
              >
                <List className="h-3.5 w-3.5 shrink-0 text-[var(--fg-faint)]" />
                <span className="truncate text-[var(--fg-muted)]">
                  {activeSection ? (
                    <>
                      {activeSection.sectnum && (
                        <span className="mr-1.5 tabular-nums">
                          {activeSection.sectnum}
                        </span>
                      )}
                      {activeSection.title}
                    </>
                  ) : (
                    "目录"
                  )}
                </span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--fg-faint)]" />
              </button>
            )}
          >
            {(close) => (
              <MobileSectionList
                sections={sections}
                activeId={activeSectionId}
                sectionHref={sectionHref}
                onPick={close}
              />
            )}
          </Popover>

          {progress > 0.04 && (
            <button
              type="button"
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              aria-label="回到顶部"
              title="回到顶部"
              className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--fg-faint)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)] active:bg-[var(--bg-subtle)]"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      {compare && (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-[var(--line)] py-1.5 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] text-[12.5px] sm:gap-x-3.5 sm:pl-[max(1rem,env(safe-area-inset-left))] sm:pr-[max(1rem,env(safe-area-inset-right))] sm:text-[13px]">
          <span className="inline-flex min-w-0 items-center gap-1">
            <GitCompareArrows className="h-4 w-4 shrink-0 text-[var(--accent)]" />
            <VersionPicker
              variant="inline"
              align="left"
              index={index}
              value={compare.base}
              onSelect={compare.onSelectBase}
              volumeId={activeVolumeId}
              chapterId={chapterId}
            />
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[var(--fg-faint)]" />
            <VersionPicker
              variant="inline"
              align="left"
              index={index}
              value={compare.target}
              onSelect={compare.onSelectTarget}
              volumeId={activeVolumeId}
              chapterId={chapterId}
            />
          </span>
          <span className="inline-flex gap-2 font-mono text-[12px] sm:gap-2.5">
            <span className="text-[var(--add-line)]">+{compare.stats.added}</span>
            <span className="text-[var(--mod-line)]">~{compare.stats.modified}</span>
            <span className="text-[var(--move-line)]">⇄{compare.stats.moved}</span>
            <span className="text-[var(--del-line)]">−{compare.stats.deleted}</span>
          </span>
          <label className="inline-flex cursor-pointer items-center gap-1.5 py-0.5 text-[var(--fg-muted)]">
            <input
              type="checkbox"
              checked={compare.changesOnly}
              onChange={(e) => compare.onToggleChangesOnly(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent)] sm:h-3.5 sm:w-3.5"
            />
            只看变更
          </label>
          <div className="flex-1" />
          <IconButton
            onClick={compare.onExit}
            aria-label="退出对比"
            title="退出对比"
            className="h-7 min-w-7 px-1.5"
          >
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      )}

      <div
        className="absolute bottom-[-1px] left-0 h-[2px] bg-[var(--accent)] transition-[width] duration-75"
        style={{ width: `${progress * 100}%`, opacity: progress > 0.002 ? 0.7 : 0 }}
      />
    </header>
  );
};
