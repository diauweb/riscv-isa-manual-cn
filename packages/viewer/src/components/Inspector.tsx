import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  Link2,
  Pencil,
  X,
} from "lucide-react";
import type { RenderedUnit, TranslationStatus, UnitMeta, UnitUpstreamRef } from "../types";
import { fetchUnitMeta } from "../utils/dataClient";
import { useBodyScrollLock } from "../lib/scroll";
import { STATUS_LABEL, formatDate, shortSha } from "../lib/snapshots";
import { prepareBlockHtml } from "./DocBlock";
import { WordDiff } from "./WordDiff";
import { cx } from "./ui";

interface InspectorProps {
  unitId: string | null;
  block: RenderedUnit | null;
  anchorId?: string | null;
  permalink: string | null;
  dataRepoUrl: string;
  upstreamRepoUrl: string;
  demoMode: boolean;
  onClose: () => void;
}

function normalizeRepoUrl(url: string): string {
  return url.replace(/\.git$/, "").replace(/\/+$/, "");
}

const UPSTREAM_CHANGE_LABEL: Record<UnitUpstreamRef["change_kind"], string> = {
  baseline: "基线",
  added: "新增",
  modified: "修改",
  moved: "移动",
};

const StatusPill: React.FC<{ status: TranslationStatus | undefined }> = ({ status }) => {
  const s = status ?? "untranslated";
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px]",
        s === "approved" && "bg-[var(--add-bg)] text-[var(--add-line)]",
        s === "machine" && "bg-[var(--accent-soft)] text-[var(--accent-fg)]",
        s === "untranslated" && "bg-[var(--bg-subtle)] text-[var(--fg-muted)]",
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {STATUS_LABEL[s]}
    </span>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section>
    <h3 className="mb-2.5 text-[12px] font-semibold tracking-wide text-[var(--fg-faint)]">{title}</h3>
    {children}
  </section>
);

export const Inspector: React.FC<InspectorProps> = ({
  unitId,
  block,
  anchorId,
  permalink,
  dataRepoUrl,
  upstreamRepoUrl,
  demoMode,
  onClose,
}) => {
  const [meta, setMeta] = useState<UnitMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const touchStartY = useRef<number | null>(null);

  useBodyScrollLock(Boolean(unitId));

  useEffect(() => {
    if (!unitId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMeta(null);
    fetchUnitMeta(unitId, demoMode)
      .then((m) => !cancelled && setMeta(m))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [unitId, demoMode]);

  useEffect(() => {
    if (!unitId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [unitId, onClose]);

  if (!unitId) return null;

  const dataRepo = normalizeRepoUrl(dataRepoUrl);
  const upstream = normalizeRepoUrl(upstreamRepoUrl);
  const editUrl = dataRepo
    ? `${dataRepo}/edit/main/units/${unitId.slice(0, 2)}/${unitId}.toml`
    : null;
  const anchor = anchorId ? anchorId.replace(/^#/, "") : null;

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // clipboard unavailable (insecure context)
    }
  };

  const CopyBtn: React.FC<{ text: string; k: string; icon: React.ReactNode; label: string }> = ({
    text,
    k,
    icon,
    label,
  }) => (
    <button
      type="button"
      onClick={() => copy(text, k)}
      className="inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--line)] px-2.5 py-1.5 text-[12.5px] text-[var(--fg-muted)] transition-colors hover:border-[var(--line-strong)] hover:text-[var(--fg)] active:bg-[var(--bg-subtle)]"
    >
      {copied === k ? <Check className="h-3.5 w-3.5 text-[var(--add-line)]" /> : icon}
      <span className="max-w-[12rem] truncate">{copied === k ? "已复制" : label}</span>
    </button>
  );

  const zhHtml = block?.zh_html ?? "";
  const isUntranslated = Boolean(
    block?.translatable && (!zhHtml.trim() || block.status === "untranslated"),
  );

  return (
    <div className="fixed inset-0 z-[55] flex items-end justify-end sm:items-stretch">
      <div className="fade-in absolute inset-0 bg-black/30 sm:bg-black/20" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="段落详情"
        className="slide-in-up sm:slide-in-right relative flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-2xl border-t border-[var(--line)] bg-[var(--bg-elevated)] shadow-[var(--shadow-pop)] sm:h-dvh sm:max-h-none sm:max-w-[34rem] sm:rounded-none sm:border-t-0 sm:border-l"
      >
        <div
          className="border-b border-[var(--line)] px-4 pt-2.5 pb-3 sm:px-5 sm:py-3.5"
          onTouchStart={(e) => {
            touchStartY.current = e.touches[0]?.clientY ?? null;
          }}
          onTouchEnd={(e) => {
            const startY = touchStartY.current;
            touchStartY.current = null;
            const endY = e.changedTouches[0]?.clientY;
            if (startY !== null && endY !== undefined && endY - startY > 45) {
              onClose();
            }
          }}
        >
          <div className="mx-auto mb-2 h-1 w-9 rounded-full bg-[var(--line-strong)] sm:hidden" />
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {block && block.translatable && (
                <StatusPill status={isUntranslated ? "untranslated" : block.status} />
              )}
              <span className="truncate font-mono text-[12px] text-[var(--fg-faint)]">
                {block?.kind ? `${block.kind} · ` : ""}
                {unitId.slice(0, 12)}
              </span>
              {meta?.origin_hint && (
                <span className="truncate font-mono text-[11px] text-[var(--fg-faint)]">
                  {meta.origin_hint}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="-mr-1 inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--fg-faint)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)] active:bg-[var(--bg-subtle)]"
            >
              <X className="h-4.5 w-4.5" />
            </button>
          </div>
        </div>

        <div className="scroll-quiet flex-1 space-y-5 overflow-x-hidden overflow-y-auto overscroll-contain px-4 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:space-y-6 sm:px-5 sm:py-5">
          <div className="space-y-2.5">
            {editUrl && (
              <a
                href={editUrl}
                target="_blank"
                rel="noreferrer"
                className="flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-[13.5px] font-medium text-white transition-opacity hover:opacity-90 dark:text-[#141519]"
              >
                <Pencil className="h-4 w-4 shrink-0" /> 在 GitHub 上改进译文
                <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-70" />
              </a>
            )}
            <div className="flex flex-wrap gap-2">
              {permalink && (
                <CopyBtn text={permalink} k="link" icon={<Link2 className="h-3.5 w-3.5 shrink-0" />} label="复制链接" />
              )}
              <CopyBtn text={unitId} k="uid" icon={<Copy className="h-3.5 w-3.5 shrink-0" />} label="单元 ID" />
              {anchor && (
                <CopyBtn text={`#${anchor}`} k="anchor" icon={<span className="font-mono text-[12px]">#</span>} label={anchor} />
              )}
            </div>
          </div>

          {block && block.translatable && (
            <div className="space-y-3 rounded-xl border border-[var(--line)] p-3.5 text-[14px] sm:p-4">
              {block.en_html.trim() ? (
                <div
                  lang="en"
                  className="doc-prose doc-scroll-x text-[var(--fg-muted)]"
                  dangerouslySetInnerHTML={{
                    __html: prepareBlockHtml(block.en_html, `insp-${unitId.slice(0, 8)}-en`),
                  }}
                />
              ) : (
                <div className="text-[12.5px] text-[var(--fg-faint)] italic">暂无英文原文快照</div>
              )}
              <div className="border-t border-[var(--line)]" />
              {zhHtml.trim() ? (
                <div
                  lang="zh-CN"
                  className="doc-prose doc-scroll-x"
                  dangerouslySetInnerHTML={{
                    __html: prepareBlockHtml(zhHtml, `insp-${unitId.slice(0, 8)}-zh`),
                  }}
                />
              ) : (
                <div className="text-[12.5px] text-[var(--fg-faint)] italic">暂未翻译</div>
              )}
            </div>
          )}

          {(meta || block) && (
            <details className="group rounded-xl border border-[var(--line)]">
              <summary className="cursor-pointer px-4 py-2.5 text-[13px] font-medium text-[var(--fg-muted)] select-none">
                AsciiDoc
              </summary>
              <div className="space-y-3 border-t border-[var(--line)] p-3.5 sm:p-4">
                {meta ? (
                  <>
                    <pre className="scroll-quiet overflow-x-auto rounded-lg bg-[var(--bg-code)] p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
                      {meta.en_raw}
                    </pre>
                    {meta.translatable && meta.zh_raw && meta.zh_raw !== meta.en_raw && (
                      <pre className="scroll-quiet overflow-x-auto rounded-lg bg-[var(--bg-code)] p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
                        {meta.zh_raw}
                      </pre>
                    )}
                  </>
                ) : (
                  <p className="text-[12px] text-[var(--fg-faint)]">
                    {loading ? "正在加载源码…" : "暂无 AsciiDoc 源码"}
                  </p>
                )}
              </div>
            </details>
          )}

          {loading && <p className="text-[13px] text-[var(--fg-faint)]">正在加载记录…</p>}
          {error && <p className="rounded-lg bg-[var(--del-bg)] p-3 text-[12.5px] text-[var(--del-line)]">{error}</p>}

          {meta && meta.upstream_history.length > 0 && (
            <Section title={`上游历史 · ${meta.upstream_history.length}`}>
              <ol className="relative space-y-3 border-l border-[var(--line)] pl-4">
                {meta.upstream_history.map((u) => (
                  <li key={`${u.sha}:${u.unit_id}:${u.change_kind}`} className="relative text-[13px]">
                    <span className="absolute top-1.5 -left-[1.33rem] h-2 w-2 rounded-full border-2 border-[var(--bg-elevated)] bg-[var(--line-strong)]" />
                    <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--fg-faint)]">
                      <span className="rounded bg-[var(--bg-subtle)] px-1.5 py-0.5 text-[11px] text-[var(--fg-muted)]">
                        {UPSTREAM_CHANGE_LABEL[u.change_kind]}
                      </span>
                      {u.ratified_tag && (
                        <span className="font-medium text-[var(--add-line)]">{u.ratified_tag}</span>
                      )}
                      {upstream ? (
                        <a href={`${upstream}/commit/${u.sha}`} target="_blank" rel="noreferrer" className="font-mono hover:text-[var(--accent-fg)]">
                          {shortSha(u.sha)}
                        </a>
                      ) : (
                        <span className="font-mono">{shortSha(u.sha)}</span>
                      )}
                      <span>{formatDate(u.date)}</span>
                    </div>
                    <p className="mt-0.5 text-[var(--fg-muted)]">{u.title}</p>
                    {u.moved_from && (
                      <p className="mt-0.5 text-[11.5px] text-[var(--fg-faint)]">
                        移动自「{u.moved_from}」
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </Section>
          )}

          {meta && meta.revisions.length > 0 && (
            <Section title={`译文修订 · ${meta.revisions.length}`}>
              <ol className="space-y-4">
                {meta.revisions.map((rev, i) => {
                  const older = meta.revisions[i + 1];
                  const zhHtml = block?.zh_html ?? "";
  const isUntranslated = Boolean(
    block?.translatable && (!zhHtml.trim() || block.status === "untranslated"),
  );

  return (
                    <li key={`${rev.commit_sha}:${i}`} className="text-[13px]">
                      <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--fg-faint)]">
                        <StatusPill status={rev.status} />
                        <span className="font-mono">{shortSha(rev.commit_sha)}</span>
                        <span>{formatDate(rev.date)}</span>
                        <span>· {rev.author}</span>
                      </div>
                      <p className="mt-1 text-[var(--fg-muted)]">{rev.message}</p>
                      <div className="mt-2 rounded-lg bg-[var(--bg-subtle)] p-3 text-[13px] leading-relaxed">
                        {older ? (
                          <WordDiff lang="zh-CN" before={older.zh} after={rev.zh} />
                        ) : (
                          <div lang="zh-CN" className="whitespace-pre-wrap">{rev.zh}</div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </Section>
          )}
        </div>
      </aside>
    </div>
  );
};
