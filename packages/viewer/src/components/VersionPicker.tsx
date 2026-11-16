import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, GitCommitHorizontal, Search, Tag, X } from "lucide-react";
import type { SiteIndex, SiteSnapshot, VolumeId } from "../types";
import {
  formatDate,
  shortSha,
  snapshotLabel,
  snapshotTouchesChapter,
} from "../lib/snapshots";
import { Popover, cx } from "./ui";

interface VersionPickerProps {
  index: SiteIndex;
  value: SiteSnapshot;
  onSelect: (s: SiteSnapshot) => void;
  volumeId?: VolumeId;
  chapterId?: string;
  /** Small inline trigger (compare bar) vs. header pill. */
  variant?: "pill" | "inline";
  align?: "left" | "right";
  prefix?: string;
}

export const VersionPicker: React.FC<VersionPickerProps> = ({
  index,
  value,
  onSelect,
  volumeId,
  chapterId,
  variant = "pill",
  align = "right",
  prefix,
}) => {
  return (
    <Popover
      align={align}
      ariaLabel="切换版本"
      className="flex min-w-0 shrink"
      panelClassName="w-full sm:w-[24rem]"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          title="切换版本"
          className={cx(
            "inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1 overflow-hidden rounded-lg text-[13px] transition-colors sm:gap-1.5",
            variant === "pill"
              ? "h-9 w-auto border border-[var(--line)] px-2 hover:border-[var(--line-strong)] hover:bg-[var(--bg-subtle)] active:bg-[var(--bg-subtle)] sm:h-8 sm:max-w-[15rem] sm:px-2.5"
              : "px-1.5 py-1 font-medium text-[var(--fg)] hover:bg-[var(--bg-subtle)] active:bg-[var(--bg-subtle)] sm:max-w-[15rem] sm:py-0.5",
            open && "bg-[var(--bg-subtle)]",
          )}
        >
          {prefix && <span className="text-[var(--fg-faint)]">{prefix}</span>}
          {value.ratified_tag ? (
            <Tag className="hidden h-3.5 w-3.5 shrink-0 text-[var(--add-line)] min-[380px]:block" />
          ) : (
            <GitCommitHorizontal className="hidden h-3.5 w-3.5 shrink-0 text-[var(--fg-faint)] min-[380px]:block" />
          )}
          <span className={cx("min-w-0 truncate", !value.ratified_tag && "font-mono")}>
            {snapshotLabel(value)}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--fg-faint)]" />
        </button>
      )}
    >
      {(close) => (
        <VersionList
          index={index}
          value={value}
          volumeId={volumeId}
          chapterId={chapterId}
          onSelect={(s) => {
            onSelect(s);
            close();
          }}
        />
      )}
    </Popover>
  );
};

const VersionList: React.FC<{
  index: SiteIndex;
  value: SiteSnapshot;
  volumeId?: VolumeId;
  chapterId?: string;
  onSelect: (s: SiteSnapshot) => void;
}> = ({ index, value, volumeId, chapterId, onSelect }) => {
  const ratified = useMemo(
    () => index.snapshots.filter((s) => s.ratified_tag).reverse(),
    [index],
  );
  const latest = index.snapshots[index.snapshots.length - 1];
  const [tab, setTab] = useState<"latest" | "ratified" | "all">(
    value.ratified_tag && ratified.length > 0
      ? "ratified"
      : latest && value.sha === latest.sha
        ? "latest"
        : "all",
  );
  const [query, setQuery] = useState("");
  const [onlyChapter, setOnlyChapter] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (window.matchMedia("(pointer: fine) and (min-width: 640px)").matches) {
      inputRef.current?.focus();
    }
  }, []);

  const list = useMemo(() => {
    if (tab === "latest") {
      return latest ? [latest] : [];
    }
    let base = tab === "ratified" ? ratified : [...index.snapshots].reverse();
    if (onlyChapter && volumeId && chapterId) {
      base = base.filter((s) => snapshotTouchesChapter(s, volumeId, chapterId));
    }
    const q = query.trim().toLowerCase();
    if (q) {
      base = base.filter((s) =>
        `${s.sha} ${s.title} ${s.ratified_tag ?? ""} ${s.date}`.toLowerCase().includes(q),
      );
    }
    return base;
  }, [tab, latest, ratified, index, onlyChapter, volumeId, chapterId, query]);

  const shown = list.slice(0, 300);

  return (
    <div className="flex max-h-[min(34rem,calc(100dvh-7rem))] flex-col">
      <div className="space-y-2.5 border-b border-[var(--line)] p-3">
        <div className="flex rounded-lg bg-[var(--bg-subtle)] p-0.5 text-[13px]">
          {(
            [
              ...(latest ? ([["latest", "最新"]] as const) : []),
              ["ratified", `正式版 · ${ratified.length}`],
              ["all", `全部提交 · ${index.snapshots.length}`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={cx(
                "flex-1 cursor-pointer rounded-md px-2 py-1.5 transition-colors sm:py-1",
                tab === k
                  ? "bg-[var(--bg-elevated)] font-medium shadow-sm"
                  : "text-[var(--fg-muted)] hover:text-[var(--fg)]",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {tab !== "latest" && (
          <>
            <label className="flex items-center gap-2 rounded-lg border border-[var(--line)] px-2.5 py-1.5 text-[16px] focus-within:border-[var(--line-strong)] sm:text-[13px]">
              <Search className="h-3.5 w-3.5 shrink-0 text-[var(--fg-faint)]" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="筛选版本…"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--fg-faint)]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="清除筛选"
                  className="cursor-pointer p-0.5 text-[var(--fg-faint)] active:text-[var(--fg)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </label>
            {volumeId && chapterId && (
              <label className="flex cursor-pointer items-center gap-2 py-0.5 text-[13px] text-[var(--fg-muted)] sm:text-[12.5px]">
                <input
                  type="checkbox"
                  checked={onlyChapter}
                  onChange={(e) => setOnlyChapter(e.target.checked)}
                  className="h-4 w-4 accent-[var(--accent)] sm:h-3.5 sm:w-3.5"
                />
                仅限本章变更
              </label>
            )}
          </>
        )}
      </div>

      <ul className="scroll-quiet min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
        {shown.length === 0 && (
          <li className="py-10 text-center text-xs text-[var(--fg-faint)]">没有匹配的版本</li>
        )}
        {shown.map((s) => {
          const selected = s.sha === value.sha;
          const isDefault = s.sha === index.default_sha;
          const isLatest = s.sha === latest?.sha;
          return (
            <li key={s.sha}>
              <button
                type="button"
                onClick={() => onSelect(s)}
                className={cx(
                  "flex w-full cursor-pointer gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors sm:py-2",
                  selected ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--bg-subtle)] active:bg-[var(--bg-subtle)]",
                )}
              >
                <span className="mt-0.5 w-3.5 shrink-0">
                  {selected && <Check className="h-3.5 w-3.5 text-[var(--accent-fg)]" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-[12.5px]">
                    {s.ratified_tag ? (
                      <span className="font-semibold text-[var(--fg)]">{s.ratified_tag}</span>
                    ) : (
                      <span className="font-mono text-[var(--fg)]">{shortSha(s.sha)}</span>
                    )}
                    <span className="text-[var(--fg-faint)]">{formatDate(s.date)}</span>
                    {isLatest && (
                      <span className="rounded bg-[var(--accent-soft)] px-1.5 text-[10.5px] font-medium text-[var(--accent-fg)]">
                        最新
                      </span>
                    )}
                    {isDefault && (
                      <span className="rounded bg-[var(--bg-subtle)] px-1.5 text-[10.5px] text-[var(--fg-muted)]">
                        默认
                      </span>
                    )}
                    <span className="ml-auto font-mono text-[10.5px] text-[var(--fg-faint)]">
                      {s.is_baseline ? (
                        "基线"
                      ) : (
                        <>
                          {s.diff.added > 0 && <span className="text-[var(--add-line)]">+{s.diff.added} </span>}
                          {s.diff.modified > 0 && <span className="text-[var(--mod-line)]">~{s.diff.modified} </span>}
                          {s.diff.deleted > 0 && <span className="text-[var(--del-line)]">−{s.diff.deleted}</span>}
                        </>
                      )}
                    </span>
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-[var(--fg-muted)]">
                    {s.title}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {list.length > shown.length && (
          <li className="py-2 text-center text-[11px] text-[var(--fg-faint)]">
            还有 {list.length - shown.length} 个版本…
          </li>
        )}
      </ul>
    </div>
  );
};
